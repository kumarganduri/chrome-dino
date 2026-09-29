// Held-out validation: runs a brain on seeds it never saw (not training, not
// the gate) for a long time each. Writes out/validation.json.
//
//   node trainer/validate.ts [--genome out/train/champion.json] [--seeds 300] [--minutes 60]
import {parseArgs} from 'node:util';
import {Pool} from './pool.ts';
import {readJson, writeJsonAtomic} from './store.ts';
import {RAMP_FRAMES, type EpisodeResult} from './episodes.ts';

const {values: args} = parseArgs({options: {
  genome: {type: 'string', default: 'out/train/champion.json'},
  seeds: {type: 'string', default: '300'},
  minutes: {type: 'string', default: '60'},
}});
const data = readJson<any>(args.genome!, null);
if (!data?.genome) throw new Error(`no genome in ${args.genome}`);
const seeds = Array.from({length: Number(args.seeds)}, (_, i) => 2_000_000_000 + i); // disjoint from training and gate
const cap = RAMP_FRAMES + Number(args.minutes) * 60 * 60;
const pool = new Pool();
const t0 = Date.now();
const per = Math.ceil(seeds.length / (pool.size * 4));
const parts: Promise<EpisodeResult[][]>[] = [];
for (let i = 0; i < seeds.length; i += per) {
  parts.push(pool.run({kind: 'eval', genomes: [data.genome], episodes: seeds.slice(i, i + per).map((seed) => ({kind: 'fresh', seed, cap})), record: true}));
}
const results = (await Promise.all(parts)).flatMap((r) => r[0]!);
await pool.close();
const crashes = results.map((r, i) => ({r, seed: seeds[i]!})).filter((x) => !x.r.survived)
    .map((x) => ({seed: x.seed, frames: x.r.frames, obstacles: x.r.crash?.obstacles}));
const summary = {
  genome: args.genome, version: data.version ?? null, gen: data.gen, seeds: seeds.length, minutesAtTopSpeed: Number(args.minutes),
  survived: seeds.length - crashes.length, crashes, gameHours: (results.reduce((a, r) => a + r.frames, 0) / 60 / 3600),
  wallSeconds: (Date.now() - t0) / 1000,
};
writeJsonAtomic('out/validation.json', summary);
if (summary.version) writeJsonAtomic(`out/validation-v${summary.version}.json`, summary);
console.log(JSON.stringify(summary, null, 1));
