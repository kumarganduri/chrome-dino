// Feasibility sweep: can Chrome's dino be survived "forever"?
// Runs the lookahead oracle on many seeds for a long time each and writes
// out/oracle-sweep.json (plus a snapshot 3 s before any crash).
//
//   node trainer/oracle-sweep.ts [seeds=200] [frames=1000000]
import {mkdirSync, writeFileSync} from 'node:fs';
import {Pool} from './pool.ts';

const seeds = Number(process.argv[2] ?? 200);
const frames = Number(process.argv[3] ?? 1_000_000);
mkdirSync('out', {recursive: true});
const pool = new Pool();
const t0 = Date.now();
let done = 0;
let crashes = 0;
const results = await Promise.all(
    Array.from({length: seeds}, (_, i) => pool.run<any>({kind: 'oracle', seed: 1000 + i, frames}).then((r) => {
      done++;
      process.stdout.write(`\r${done}/${seeds} seeds, ${results_crashed(r)}`);
      return r;
    })));
await pool.close();
function results_crashed(r: any): string {
  if (r.crashed) crashes++;
  return `${crashes} crashed`;
}
const summary = {
  seeds,
  framesPerSeed: frames,
  gameHoursPerSeed: frames / 60 / 3600,
  survived: results.filter((r) => !r.crashed).length,
  crashed: results.filter((r) => r.crashed).map((r) => ({seed: r.seed, frame: r.frames, death: r.death})),
  totalFrames: results.reduce((a, r) => a + r.frames, 0),
  wallSeconds: (Date.now() - t0) / 1000,
};
writeFileSync('out/oracle-sweep.json', JSON.stringify({summary, crashes: results.filter((r) => r.crashed)}, null, 1));
console.log('\n' + JSON.stringify(summary, null, 1));
