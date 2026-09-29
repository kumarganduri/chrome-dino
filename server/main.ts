// dino.forever live server. node:http + node:sqlite, no framework.
//
//   ┌───────────── main thread ─────────────┐        ┌── verify worker ──┐
//   │ live run: Chrome's game stepped to     │  jobs  │ race / attack /   │
//   │ wall-clock time, checkpoint every 60 s │ ─────► │ gate / lessons    │
//   │ SSE fan-out · HTTP routes · SQLite     │ ◄───── │ re-plays          │
//   └────────────────────────────────────────┘        └───────────────────┘
//
// Every visitor re-simulates the same run from (seed, checkpoint, brain), so
// the server only ever sends parameters, never frames.
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {randomInt, timingSafeEqual} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import path from 'node:path';
import {loadEngine} from '../src/engine/load.ts';
import {installAttackHook} from '../src/hook/attack.ts';
import {Game, FRAME_MS, type Snapshot} from '../src/engine/game.ts';
import {BrainPolicy} from '../src/neat/policy.ts';
import {Network, validateGenome, type Genome} from '../src/neat/genome.ts';
import {GATE_SEED_BASE} from '../trainer/episodes.ts';
import {openDb, getMeta, setMeta} from './db.ts';
import {validateDrops, validateRaceInputs, type AttackVerdict, type RunRecord} from './verify.ts';

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? path.resolve('out/server');
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? '';
const DEPLOY_KEY = process.env.DEPLOY_KEY ?? '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'https://kumarganduri14.gitlab.io,http://localhost:4173,http://127.0.0.1:4173')
    .split(',').map((s) => s.trim()).filter(Boolean);
const BOOTSTRAP = process.env.BOOTSTRAP_DIR ?? path.resolve('web/data');
const CHECKPOINT_EVERY = 3600; // frames (60 s)
const KEEP_CHECKPOINTS = 40;
const NEXT_RUN_DELAY_MS = 3000;
const GATE_SAMPLE = Number(process.env.GATE_SAMPLE ?? 20);
const MAX_BODY = 32 * 1024;

const engine = await loadEngine();
installAttackHook(engine);
const db = openDb(DATA_DIR);

// ── Verify worker ──────────────────────────────────────────────────────────
const worker = new Worker(new URL('./verify-worker.ts', import.meta.url));
let jobId = 0;
const pending = new Map<number, {resolve: (v: any) => void; reject: (e: Error) => void}>();
worker.on('message', (m: {id: number; ok: boolean; value?: unknown; error?: string}) => {
  const p = pending.get(m.id);
  pending.delete(m.id);
  if (m.ok) p?.resolve(m.value);
  else p?.reject(new Error(m.error));
});
function job<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++jobId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {resolve, reject});
    worker.postMessage({...msg, id});
  });
}

// ── Champion ───────────────────────────────────────────────────────────────
interface Champion {
  version: number;
  gen: number;
  genome: Genome;
  label: string;
}

function loadChampion(): Champion {
  const row = db.prepare('SELECT version, gen, genome FROM champions ORDER BY version DESC LIMIT 1').get() as
      {version: number; gen: number; genome: string} | undefined;
  if (row) return {version: row.version, gen: row.gen, genome: validateGenome(JSON.parse(row.genome)), label: `champion v${row.version}`};
  // No promoted champion yet: run the best published brain, labelled honestly.
  for (const [file, label] of [['champion.json', 'champion'], ['leader.json', 'leader']] as const) {
    const p = path.join(BOOTSTRAP, file);
    if (!existsSync(p)) continue;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    if (!data?.genome) continue;
    const version = file === 'champion.json' ? data.version : 0;
    return {version, gen: data.gen, genome: validateGenome(data.genome),
      label: version ? `champion v${version}` : `${label} · gen ${data.gen} · still training`};
  }
  throw new Error(`no champion in the database and nothing to bootstrap from in ${BOOTSTRAP}`);
}

let champion = loadChampion();
let pendingChampion: Champion | null = null;

// ── Live run ───────────────────────────────────────────────────────────────
interface Live {
  id: number;
  seed: number;
  startWall: number;
  segments: RunRecord['segments'];
  game: Game;
  policy: BrainPolicy;
  ring: Snapshot[];
  latestCheckpoint: Snapshot | null;
  endedAt: number | null;
}

let live: Live;

function checkpointsOf(runId: number): Snapshot[] {
  return (db.prepare('SELECT snapshot FROM checkpoints WHERE run_id = ? ORDER BY frame').all(runId) as Array<{snapshot: string}>)
      .map((r) => JSON.parse(r.snapshot));
}

function saveCheckpoint(snap: Snapshot): void {
  db.prepare('INSERT OR REPLACE INTO checkpoints (run_id, frame, snapshot) VALUES (?, ?, ?)').run(live.id, snap.frame, JSON.stringify(snap));
  db.prepare(`DELETE FROM checkpoints WHERE run_id = ? AND frame NOT IN
      (SELECT frame FROM checkpoints WHERE run_id = ? ORDER BY frame DESC LIMIT ?) AND frame != 0`).run(live.id, live.id, KEEP_CHECKPOINTS);
  live.latestCheckpoint = snap;
}

function startRun(): void {
  const seed = randomInt(1, 2 ** 31);
  const startWall = Date.now();
  const segments: RunRecord['segments'] = [{fromFrame: 0, genome: champion.genome, checkpoint: null}];
  const info = db.prepare('INSERT INTO runs (seed, start_wall, segments) VALUES (?, ?, ?)').run(seed, startWall, JSON.stringify(
      segments.map((s) => ({...s, version: champion.version}))));
  const game = Game.create(engine, seed);
  live = {id: Number(info.lastInsertRowid), seed, startWall, segments, game, policy: new BrainPolicy(new Network(champion.genome)),
    ring: [], latestCheckpoint: null, endedAt: null};
  saveCheckpoint(game.snapshot());
  broadcast('run', {run: runPayload(), serverNow: Date.now()});
}

function resumeRun(): boolean {
  const row = db.prepare('SELECT id, seed, start_wall, segments FROM runs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as
      {id: number; seed: number; start_wall: number; segments: string} | undefined;
  if (!row) return false;
  const segments = JSON.parse(row.segments) as RunRecord['segments'];
  const cps = checkpointsOf(row.id);
  const game = Game.create(engine, row.seed);
  const last = cps.at(-1);
  if (last) game.restore(last);
  const seg = segments.at(-1)!;
  live = {id: row.id, seed: row.seed, startWall: row.start_wall, segments, game, policy: new BrainPolicy(new Network(seg.genome)),
    ring: [], latestCheckpoint: last ?? null, endedAt: null};
  console.log(`resumed run ${row.id} at frame ${game.frame}`);
  return true;
}

function runPayload() {
  return {seed: live.seed, startWall: live.startWall, checkpoint: live.latestCheckpoint, championVersion: champion.version};
}

function tick(): void {
  if (live.endedAt) return;
  const target = Math.floor((Date.now() - live.startWall) / FRAME_MS);
  let budget = 60 * 60 * 20; // never block the event loop for long; catch up over several ticks
  while (live.game.frame < target && budget-- > 0) {
    const g = live.game;
    if (g.frame % 60 === 0) {
      live.ring.push(g.snapshot());
      if (live.ring.length > 6) live.ring.shift();
    }
    if (!g.step(live.policy.keys(g.runner))) {
      onLiveCrash();
      return;
    }
    if (g.frame % CHECKPOINT_EVERY === 0) {
      saveCheckpoint(g.snapshot());
      if (pendingChampion) swapChampion();
    }
  }
}

function swapChampion(): void {
  champion = pendingChampion!;
  pendingChampion = null;
  live.segments.push({fromFrame: live.game.frame, genome: champion.genome, checkpoint: live.latestCheckpoint});
  live.policy = new BrainPolicy(new Network(champion.genome));
  db.prepare('UPDATE runs SET segments = ? WHERE id = ?').run(JSON.stringify(live.segments), live.id);
  broadcast('promotion', {champion: championPayload()});
  broadcast('run', {run: runPayload(), serverNow: Date.now()});
}

function onLiveCrash(): void {
  const g = live.game;
  const r = g.runner;
  live.endedAt = Date.now();
  const obstacles = r.horizon.obstacles.slice(0, 3).map((o: any) => `${o.typeConfig.type}${o.size}@${o.yPos}`).join(' ');
  const snapshot = live.ring.find((s) => s.frame <= g.frame - 180) ?? live.ring[0] ?? g.snapshot();
  db.prepare('UPDATE runs SET ended_at = ?, frames = ?, crashed = 1 WHERE id = ?').run(live.endedAt, g.frame, live.id);
  db.prepare(`INSERT INTO lessons (kind, run_id, frames, speed, obstacles, snapshot, genome, created_at)
      VALUES ('live', ?, ?, ?, ?, ?, ?, ?)`).run(live.id, g.frame, r.currentSpeed, obstacles, JSON.stringify(snapshot),
      JSON.stringify(champion.genome), Date.now());
  broadcast('crash', {crash: {seed: live.seed, frames: g.frame, obstacles, speed: r.currentSpeed, snapshot, genome: champion.genome}});
  console.log(`live run ${live.id} crashed at frame ${g.frame} (${obstacles})`);
  setTimeout(() => {
    if (pendingChampion) {
      champion = pendingChampion;
      pendingChampion = null;
      broadcast('promotion', {champion: championPayload()});
    }
    startRun();
    broadcastBoard();
  }, NEXT_RUN_DELAY_MS);
}

// ── SSE ────────────────────────────────────────────────────────────────────
const clients = new Set<ServerResponse>();

function broadcast(type: string, data: unknown): void {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function championPayload() {
  return {version: champion.version || null, genome: champion.genome, label: champion.label, gen: champion.gen};
}

function stats() {
  const training = getMeta(db, 'training', {generation: 0, framesSimulated: 0});
  const count = (sql: string) => (db.prepare(sql).get() as {n: number}).n;
  return {
    watchers: clients.size,
    generation: training.generation,
    framesSimulated: training.framesSimulated,
    runsVerified: count('SELECT COUNT(*) AS n FROM races') + count('SELECT COUNT(*) AS n FROM attacks'),
    attacksSurvived: count(`SELECT COUNT(*) AS n FROM attacks WHERE verdict = 'survived'`),
    kills: count(`SELECT COUNT(*) AS n FROM lessons WHERE kind = 'attack'`),
  };
}

function board() {
  const survival = (db.prepare(`SELECT id, frames, segments FROM runs WHERE frames IS NOT NULL ORDER BY frames DESC LIMIT 5`).all() as
      Array<{id: number; frames: number; segments: string}>).map((r) => ({
    name: `run #${r.id}`, value: r.frames / 60, detail: `v${JSON.parse(r.segments).at(-1)?.version ?? '?'}`,
  }));
  const current = {name: `run #${live.id}`, value: live.game.frame / 60, detail: 'live now'};
  const allSurvival = [...survival, current].sort((a, b) => b.value - a.value).slice(0, 5);
  const killers = (db.prepare(`SELECT name, COUNT(*) AS n FROM lessons WHERE kind = 'attack' GROUP BY name ORDER BY n DESC LIMIT 5`).all() as
      Array<{name: string; n: number}>).map((r) => ({name: r.name, value: r.n}));
  const humans = (db.prepare(`SELECT name, MAX(frames) AS frames, MAX(score) AS score FROM races GROUP BY name ORDER BY frames DESC LIMIT 5`).all() as
      Array<{name: string; frames: number; score: number}>).map((r) => ({name: r.name, value: r.frames / 60, detail: `score ${r.score}`}));
  return {survival: allSurvival, killers, humans};
}

function state() {
  return {serverNow: Date.now(), champion: championPayload(), run: runPayload(), stats: stats(), board: board(),
    history: getMeta(db, 'history', [])};
}

function broadcastBoard(): void {
  broadcast('board', {board: board()});
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const buckets = new Map<string, {tokens: number; at: number}>();
function allow(ip: string, perMinute = 12): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? {tokens: perMinute, at: now};
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw Object.assign(new Error('payload too large'), {status: 413});
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('invalid JSON'), {status: 400});
  }
}

const BANNED = /(fuck|shit|cunt|nigg|fag|rape|hitler|nazi)/i;
function cleanName(raw: unknown): string {
  const name = String(raw ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
  if (name.length < 3 || BANNED.test(name)) return 'anonymous';
  return name;
}

function authorized(req: IncomingMessage): boolean {
  const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  const want = Buffer.from(DEPLOY_KEY);
  return DEPLOY_KEY.length >= 16 && got.length === want.length && timingSafeEqual(got, want);
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.map': 'application/json',
};

async function serveStatic(urlPath: string, res: ServerResponse): Promise<boolean> {
  if (!PUBLIC_DIR) return false;
  const file = path.join(PUBLIC_DIR, urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath);
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    const body = urlPath === '/config.js' ?
      Buffer.from('window.DINO_API = location.origin;\n') :
      await readFile(file);
    res.writeHead(200, {'content-type': STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream'});
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const ip = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? '?');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, {ok: true, run: live.id, frame: live.game.frame});
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state());
    if (req.method === 'GET' && url.pathname === '/api/live') {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
        'x-accel-buffering': 'no'});
      res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (!allow(ip)) return send(res, 429, {error: 'slow down'});
      const body = await readBody(req);
      const seed = Number(body.seed) >>> 0;
      const inputs = validateRaceInputs(body.inputs);
      const result = await job<{frames: number; score: number}>({kind: 'race', seed, inputs});
      db.prepare('INSERT INTO races (name, seed, frames, score, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(cleanName(body.name), seed, result.frames, result.score, Date.now());
      broadcastBoard();
      return send(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/attack') {
      if (!allow(ip, 6)) return send(res, 429, {error: 'slow down'});
      const body = await readBody(req);
      if ((Number(body.seed) >>> 0) !== live.seed) return send(res, 409, {verdict: 'illegal', reason: 'that run is over'});
      const forkFrame = Number(body.forkFrame);
      if (!Number.isInteger(forkFrame) || forkFrame < 0 || forkFrame > live.game.frame + 120 ||
          forkFrame < live.game.frame - 60 * 60 * 10) {
        return send(res, 400, {verdict: 'illegal', reason: 'fork frame outside the last 10 minutes of the live run'});
      }
      const drops = validateDrops(body.drops, forkFrame);
      const name = cleanName(body.name);
      const run: RunRecord = {seed: live.seed, segments: live.segments};
      const verdict = await job<AttackVerdict>({kind: 'attack', run, checkpoints: checkpointsOf(live.id), forkFrame, drops});
      db.prepare('INSERT INTO attacks (name, verdict, created_at) VALUES (?, ?, ?)').run(name, verdict.verdict, Date.now());
      if (verdict.verdict === 'kill') {
        db.prepare(`INSERT INTO lessons (kind, name, run_id, frames, speed, obstacles, snapshot, genome, drops, created_at)
            VALUES ('attack', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, live.id, verdict.frame, verdict.speed, verdict.obstacles,
            JSON.stringify(verdict.snapshot), JSON.stringify(champion.genome), JSON.stringify(drops), Date.now());
        broadcast('kill', {kill: {name, obstacles: verdict.obstacles, speed: verdict.speed, snapshot: verdict.snapshot, genome: champion.genome}});
      }
      broadcastBoard();
      return send(res, 200, verdict);
    }
    // ── Trainer endpoints (deploy key) ──
    if (url.pathname.startsWith('/api/trainer/')) {
      if (!authorized(req)) return send(res, 401, {error: 'unauthorized'});
      if (req.method === 'POST' && url.pathname === '/api/trainer/progress') {
        const body = await readBody(req, 2 * 1024 * 1024);
        setMeta(db, 'training', {generation: Number(body.generation) || 0, framesSimulated: Number(body.framesSimulated) || 0});
        if (Array.isArray(body.history)) setMeta(db, 'history', body.history.slice(-600));
        broadcast('stats', {stats: stats()});
        return send(res, 200, {ok: true});
      }
      if (req.method === 'GET' && url.pathname === '/api/trainer/lessons') {
        const since = Number(url.searchParams.get('since') ?? 0);
        const rows = db.prepare('SELECT id, kind, name, frames, speed, obstacles, snapshot FROM lessons WHERE id > ? ORDER BY id LIMIT 200').all(since);
        return send(res, 200, {lessons: (rows as any[]).map((r) => ({...r, snapshot: JSON.parse(r.snapshot)}))});
      }
      if (req.method === 'POST' && url.pathname === '/api/trainer/candidate') {
        const body = await readBody(req, 1024 * 1024);
        const genome = validateGenome(body.genome);
        const gateSeeds = Number(body.gate?.seeds ?? 0);
        if (gateSeeds < 100 || body.gate?.passed !== gateSeeds) return send(res, 400, {error: 'candidate must pass its full gate first'});
        const sample = Array.from({length: GATE_SAMPLE}, () => GATE_SEED_BASE + randomInt(0, gateSeeds));
        const gate = await job<{passed: number; failedSeeds: number[]}>({kind: 'gate', genome, seeds: sample});
        if (gate.passed !== sample.length) return send(res, 422, {error: 'gate re-verification failed', failedSeeds: gate.failedSeeds});
        const lessons = (db.prepare('SELECT id, snapshot FROM lessons').all() as Array<{id: number; snapshot: string}>)
            .map((l) => ({id: l.id, snapshot: JSON.parse(l.snapshot)}));
        const check = await job<{failed: number[]}>({kind: 'lessons', genome, lessons});
        if (check.failed.length) return send(res, 422, {error: 'candidate fails stored lessons', failed: check.failed});
        const version = ((db.prepare('SELECT MAX(version) AS v FROM champions').get() as {v: number | null}).v ?? 0) + 1;
        db.prepare('INSERT INTO champions (version, gen, genome, gate, promoted_at) VALUES (?, ?, ?, ?, ?)')
            .run(version, Number(body.gen) || 0, JSON.stringify(genome), JSON.stringify({...body.gate, resampled: sample.length}), Date.now());
        pendingChampion = {version, gen: Number(body.gen) || 0, genome, label: `champion v${version}`};
        console.log(`champion v${version} accepted; takes over at the next checkpoint`);
        return send(res, 200, {version, takesOverAtFrame: Math.ceil((live.game.frame + 1) / CHECKPOINT_EVERY) * CHECKPOINT_EVERY});
      }
      return send(res, 404, {error: 'not found'});
    }
    if (req.method === 'GET' && (await serveStatic(url.pathname, res))) return;
    send(res, 404, {error: 'not found'});
  } catch (e) {
    const status = (e as {status?: number}).status ?? 400;
    send(res, status, {error: (e as Error).message});
  }
});

if (!resumeRun()) startRun();
setInterval(tick, 250);
setInterval(() => broadcast('stats', {stats: stats()}), 5000);
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15_000);
server.listen(PORT, () => console.log(`dino.forever server on :${PORT} (run ${live.id}, ${champion.label})`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // Checkpoint so a restart resumes the same run with minimal catch-up.
    if (!live.endedAt) saveCheckpoint(live.game.snapshot());
    process.exit(0);
  });
}
