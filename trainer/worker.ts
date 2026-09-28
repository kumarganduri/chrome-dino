// Worker entry: loads the engine once, then serves tasks from the pool.
import {parentPort} from 'node:worker_threads';
import {loadEngine} from '../src/engine/load.ts';
import {Game} from '../src/engine/game.ts';
import {plannerKeys} from '../src/oracle/planner.ts';
import {handleEval, type EvalTask} from './evaluate.ts';

const engine = await loadEngine();

function oracleRun(seed: number, maxFrames: number) {
  const g = Game.create(engine, seed);
  const t0 = performance.now();
  let lastSnap = g.snapshot();
  while (g.frame < maxFrames) {
    if (g.frame % 180 === 0) {
      lastSnap = g.snapshot();
    }
    if (!g.step(plannerKeys(g))) {
      break;
    }
  }
  const o = g.runner.horizon.obstacles;
  return {
    seed,
    frames: g.frame,
    crashed: g.crashed,
    maxSpeed: g.runner.currentSpeed,
    ms: performance.now() - t0,
    death: g.crashed ? o.map((x: any) => `${x.typeConfig.type}${x.size}@${x.yPos}`).join(' ') : null,
    snapshot: g.crashed ? lastSnap : null,
  };
}

parentPort!.on('message', (task: any) => {
  try {
    let value: unknown;
    switch (task.kind) {
      case 'oracle':
        value = oracleRun(task.seed, task.frames);
        break;
      case 'clearable': {
        // Can the lookahead oracle survive this lesson (600 frames from its snapshot)?
        const g = Game.create(engine, 0);
        g.restore(task.snapshot);
        const end = g.frame + 600;
        while (g.frame < end && g.step(plannerKeys(g))) {}
        value = !g.crashed;
        break;
      }
      case 'eval':
        value = handleEval(engine, task as EvalTask);
        break;
      default:
        throw new Error(`unknown task ${task.kind}`);
    }
    parentPort!.postMessage({ok: true, value});
  } catch (e) {
    parentPort!.postMessage({ok: false, error: e instanceof Error ? e.stack ?? e.message : String(e)});
  }
});
