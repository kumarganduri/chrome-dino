// Worker thread for server re-plays, so a long verification never stalls the
// live run or the SSE streams on the main thread.
import {parentPort} from 'node:worker_threads';
import {loadEngine} from '../src/engine/load.ts';
import {installAttackHook} from '../src/hook/attack.ts';
import {Game} from '../src/engine/game.ts';
import {BrainPolicy} from '../src/neat/policy.ts';
import {Network, validateGenome} from '../src/neat/genome.ts';
import {replayAttack, replayRace, verifyGate} from './verify.ts';

const engine = await loadEngine();
installAttackHook(engine);

parentPort!.on('message', (msg: any) => {
  try {
    let value: unknown;
    switch (msg.kind) {
      case 'race':
        value = replayRace(engine, msg.seed, msg.inputs);
        break;
      case 'attack':
        value = replayAttack(engine, msg.run, msg.checkpoints, msg.forkFrame, msg.drops);
        break;
      case 'gate':
        value = verifyGate(engine, msg.genome, msg.seeds);
        break;
      case 'lessons': {
        // Does the candidate survive every stored lesson (600 frames from 3 s before impact)?
        const policy = new BrainPolicy(new Network(validateGenome(msg.genome)));
        const failed: number[] = [];
        for (const l of msg.lessons as Array<{id: number; snapshot: any}>) {
          const g = Game.create(engine, 0);
          g.restore(l.snapshot);
          const end = g.frame + 600;
          while (g.frame < end && g.step(policy.keys(g.runner))) {}
          if (g.crashed) failed.push(l.id);
        }
        value = {failed};
        break;
      }
      default:
        throw new Error(`unknown job ${msg.kind}`);
    }
    parentPort!.postMessage({id: msg.id, ok: true, value});
  } catch (e) {
    parentPort!.postMessage({id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e)});
  }
});
