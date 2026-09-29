// Publishes a shared live run that needs no server.
//
// A run is fully determined by (seed, champion genome); its current frame is
// determined by the wall clock: frame = (now − startWall) / (1000/60). So every
// browser can compute the same run. This script simulates the run ahead of time,
// proves it never crashes in the window, and writes hourly checkpoints so a
// visitor only fast-forwards from the latest one (≤ 1 hour of frames).
//
//   web/data/live/run.json          seed, start, champion, checkpoint spacing, verified window
//   web/data/live/<frame>.json      snapshot at every multiple of CHECKPOINT_EVERY
//
//   node trainer/shared-run.ts --seed S --start MS [--days 8] [--server-db /tmp/dino-srv/dino.sqlite]
import {parseArgs} from 'node:util';
import {mkdirSync, rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {loadEngine} from '../src/engine/load.ts';
import {Game, FRAME_MS, type Snapshot} from '../src/engine/game.ts';
import {BrainPolicy} from '../src/neat/policy.ts';
import {Network, validateGenome} from '../src/neat/genome.ts';
import {readJson, writeJsonAtomic} from './store.ts';

const {values: args} = parseArgs({options: {
  seed: {type: 'string'},
  start: {type: 'string'},
  days: {type: 'string', default: '8'},
  champion: {type: 'string', default: 'web/data/champion.json'},
  out: {type: 'string', default: 'web/data/live'},
  'server-db': {type: 'string', default: ''},
}});
const CHECKPOINT_EVERY = 216_000; // 1 hour of game time
const seed = Number(args.seed);
const startWall = Number(args.start);
if (!Number.isInteger(seed) || !Number.isFinite(startWall)) throw new Error('--seed and --start (ms since epoch) are required');
const champion = readJson<any>(args.champion!, null);
const genome = validateGenome(champion?.genome);
const endFrame = Number(args.days) * 24 * CHECKPOINT_EVERY;

const engine = await loadEngine();
const policy = new BrainPolicy(new Network(genome));

// Optional cross-check against a live server's own checkpoints of this run.
const serverHashes = new Map<number, number>();
if (args['server-db']) {
  const db = new DatabaseSync(args['server-db'], {readOnly: true});
  const run: any = db.prepare('SELECT id, seed FROM runs WHERE seed = ? ORDER BY id DESC LIMIT 1').get(seed);
  if (!run) throw new Error(`run with seed ${seed} not found in ${args['server-db']}`);
  const probe = Game.create(engine, 0);
  for (const row of db.prepare('SELECT frame, snapshot FROM checkpoints WHERE run_id = ?').all(run.id) as any[]) {
    probe.restore(JSON.parse(row.snapshot) as Snapshot);
    serverHashes.set(row.frame, probe.fullHash());
  }
  console.log(`cross-checking against ${serverHashes.size} server checkpoints`);
}

rmSync(args.out!, {recursive: true, force: true});
mkdirSync(args.out!, {recursive: true});
const g = Game.create(engine, seed);
let matched = 0;
const t0 = performance.now();
while (g.frame < endFrame) {
  if (g.frame % CHECKPOINT_EVERY === 0) writeJsonAtomic(`${args.out}/${g.frame}.json`, g.snapshot());
  const want = serverHashes.get(g.frame);
  if (want !== undefined) {
    if (g.fullHash() !== want) throw new Error(`mismatch with the live server at frame ${g.frame}`);
    matched++;
  }
  if (!g.step(policy.keys(g.runner))) {
    throw new Error(`the champion crashes at frame ${g.frame} (${(g.frame / 216000).toFixed(2)} h): not publishing`);
  }
  if (g.frame % (CHECKPOINT_EVERY * 24) === 0) {
    process.stdout.write(`\r${(g.frame / CHECKPOINT_EVERY / 24).toFixed(0)} days simulated, no crash`);
  }
}
writeJsonAtomic(`${args.out}/${g.frame}.json`, g.snapshot());
const meta = {
  seed, startWall, startedAt: new Date(startWall).toISOString(),
  championVersion: champion.version, checkpointEvery: CHECKPOINT_EVERY, frameMs: FRAME_MS,
  verifiedUntilFrame: g.frame, verifiedUntil: new Date(startWall + g.frame * FRAME_MS).toISOString(),
  finalScore: Math.round(g.runner.distanceMeter.getActualDistance(Math.ceil(g.runner.distanceRan))),
  serverCheckpointsMatched: matched,
};
writeJsonAtomic(`${args.out}/run.json`, meta);
console.log(`\n${JSON.stringify(meta, null, 1)}\n${((performance.now() - t0) / 1000).toFixed(0)} s`);
