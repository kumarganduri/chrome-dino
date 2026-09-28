// Throughput benchmark (M1 exit criterion): frames per second on one core for
// the bare engine, the engine + a NEAT brain, and the lookahead oracle.
import {loadEngine} from '../src/engine/load.ts';
import {Game} from '../src/engine/game.ts';
import {BrainPolicy} from '../src/neat/policy.ts';
import {Network, validateGenome} from '../src/neat/genome.ts';
import {oracleKeys} from '../src/oracle/oracle.ts';
import {plannerKeys} from '../src/oracle/planner.ts';
import {readJson} from './store.ts';

const engine = await loadEngine();
const leader = readJson<any>('web/data/leader.json', null);

function measure(label: string, frames: number, keys: (g: Game) => any): void {
  let done = 0;
  let seed = 1;
  const t0 = performance.now();
  while (done < frames) {
    const g = Game.create(engine, seed++);
    while (done < frames && g.step(keys(g))) done++;
    done++;
  }
  const s = (performance.now() - t0) / 1000;
  const fps = done / s;
  console.log(`${label.padEnd(28)} ${fps >= 1e6 ? `${(fps / 1e6).toFixed(2)} M` : `${(fps / 1e3).toFixed(1)} k`} frames/s`);
}

measure('engine + rule oracle', 2_000_000, (g) => oracleKeys(g.runner));
if (leader?.genome) {
  const policy = new BrainPolicy(new Network(validateGenome(leader.genome)));
  measure('engine + NEAT brain', 2_000_000, (g) => policy.keys(g.runner));
}
measure('lookahead planner oracle', 100_000, (g) => plannerKeys(g));
