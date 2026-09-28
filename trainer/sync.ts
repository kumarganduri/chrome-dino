// Bridges the trainer (this machine) and the live server, every 60 s:
//
//   out/train/history.json  ──POST /api/trainer/progress──►  server (chart, counters)
//   out/train/champion.json ──POST /api/trainer/candidate─►  server re-verifies, promotes
//   out/train/inbox.json    ◄──GET /api/trainer/lessons───  live-run crashes + verified kills
//
//   DINO_SERVER=https://dino-forever.fly.dev DINO_DEPLOY_KEY=… node trainer/sync.ts [--once]
// (or put both in ~/.dino-forever.env as KEY=value lines)
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {readJson, writeJsonAtomic} from './store.ts';

const envFile = path.join(homedir(), '.dino-forever.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}
const SERVER = (process.env.DINO_SERVER ?? '').replace(/\/$/, '');
const KEY = process.env.DINO_DEPLOY_KEY ?? '';
const OUT = process.env.DINO_OUT ?? 'out/train';
if (!SERVER || !KEY) {
  console.error('set DINO_SERVER and DINO_DEPLOY_KEY (env or ~/.dino-forever.env)');
  process.exit(2);
}
const file = (f: string) => path.join(OUT, f);
const headers = {authorization: `Bearer ${KEY}`, 'content-type': 'application/json'};

async function once(): Promise<void> {
  const state = readJson<{lastLesson: number; uploadedVersion: number}>(file('sync-state.json'), {lastLesson: 0, uploadedVersion: 0});
  const history = readJson<any[]>(file('history.json'), []);
  const step = Math.max(1, Math.ceil(history.length / 600));
  const thin = history.filter((_, i) => i % step === 0 || i === history.length - 1)
      .map((r) => ({gen: r.gen, best: +r.best.toFixed(4), mean: +r.mean.toFixed(4), gateTried: r.gateTried, champion: r.champion}));
  await post('/api/trainer/progress', {
    generation: history.length ? history.at(-1).gen + 1 : 0,
    framesSimulated: history.reduce((a, r) => a + (r.framesSimulated ?? 0), 0),
    history: thin,
  });

  const champion = readJson<any>(file('champion.json'), null);
  if (champion && champion.version > state.uploadedVersion) {
    console.log(`uploading champion v${champion.version} (server re-verifies ${champion.gate?.seeds} gate seeds sample)…`);
    const res = await fetch(`${SERVER}/api/trainer/candidate`, {method: 'POST', headers, body: JSON.stringify(champion)});
    const body = await res.json();
    console.log(res.ok ? `  accepted as server v${body.version}` : `  refused: ${body.error}`);
    if (res.ok) state.uploadedVersion = champion.version;
  }

  const lessons = await (await fetch(`${SERVER}/api/trainer/lessons?since=${state.lastLesson}`, {headers})).json();
  if (lessons.lessons?.length) {
    const inbox = readJson<any[]>(file('inbox.json'), []);
    inbox.push(...lessons.lessons);
    writeJsonAtomic(file('inbox.json'), inbox);
    state.lastLesson = lessons.lessons.at(-1).id;
    console.log(`pulled ${lessons.lessons.length} lesson(s) from the server`);
  }
  writeJsonAtomic(file('sync-state.json'), state);
}

async function post(p: string, body: unknown): Promise<void> {
  const res = await fetch(`${SERVER}${p}`, {method: 'POST', headers, body: JSON.stringify(body)});
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
}

do {
  try {
    await once();
  } catch (e) {
    console.error(`sync failed: ${(e as Error).message}`);
  }
  if (process.argv.includes('--once')) break;
  await new Promise((r) => setTimeout(r, 60_000));
} while (true);
