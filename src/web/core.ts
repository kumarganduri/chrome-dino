// Browser entry: the vendored engine plus everything that runs a game, a
// brain, or a determinism check in a page. Bundled to dist/core.js.
import * as engine from '../engine/vendor-entry.ts';

export {engine};
export {Game, FRAME_MS} from '../engine/game.ts';
export {Network, validateGenome, activation, INPUTS, OUTPUTS} from '../neat/genome.ts';
export {BrainPolicy} from '../neat/policy.ts';
export {sense, SENSE_SIZE} from '../hook/sense.ts';
export {applyKeys} from '../hook/act.ts';
export {oracleKeys, DEFAULT_ORACLE} from '../oracle/oracle.ts';
export {plannerKeys} from '../oracle/planner.ts';
export {Rng} from '../hook/rng.ts';
export {Hasher} from '../hook/hash.ts';
export {drive} from '../engine/testdrive.ts';
export {Population, DEFAULT_NEAT} from '../neat/population.ts';
export {installAttackHook, queueDrop, dropCheck} from '../hook/attack.ts';
export type {Genome} from '../neat/genome.ts';
