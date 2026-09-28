// Lookahead oracle: at each decision frame, forks the real game (snapshot),
// tries every action, plays each fork `horizon` frames ahead with the rule
// oracle, and keeps the action that survives longest. Ties prefer doing
// nothing, so jumps happen as late as is safe.
//
//   frame t ──┬─ fork: run      → rules × H → survived h0
//             ├─ fork: jump     → rules × H → survived h1
//             ├─ fork: duck     → rules × H → survived h2
//             └─ fork: fastfall → rules × H → survived h3   (airborne only)
//   choose argmax(h), tie → earliest in the list
//
// Because obstacle generation does not depend on the dino's actions, the
// forks see the true future; this is a feasibility yardstick, not a player.
import type {Game} from '../engine/game.ts';
import type {Keys} from '../hook/act.ts';
import {DEFAULT_ORACLE, oracleKeys} from './oracle.ts';

const RUN: Keys = {jump: false, down: false};
const JUMP: Keys = {jump: true, down: false};
const DOWN: Keys = {jump: false, down: true};

export interface PlannerStats {
  decisions: number;
  forks: number;
}

export function plannerKeys(game: Game, horizon = 90, stats?: PlannerStats): Keys {
  const r = game.runner;
  const t = r.tRex;
  const front = t.xPos + t.config.width;
  const near = r.horizon.obstacles.some((o: any) => o.xPos + o.width > t.xPos && o.xPos - front < 360);
  if (!near && !t.jumping && !t.ducking) {
    return RUN;
  }
  const candidates = t.jumping ? [RUN, DOWN] : [RUN, JUMP, DOWN];
  const snap = game.snapshot();
  let best = candidates[0]!;
  let bestScore = -1;
  for (const first of candidates) {
    game.restore(snap);
    let h = 0;
    if (game.step(first)) {
      h = 1;
      // Hold the chosen key for a few frames so the action is meaningful.
      for (; h < 6 && game.step(first); h++) {}
      for (; h < horizon && game.step(oracleKeys(game.runner, DEFAULT_ORACLE)); h++) {}
    }
    if (stats) {
      stats.forks++;
    }
    if (h > bestScore) {
      bestScore = h;
      best = first;
      if (h >= horizon) {
        break;
      }
    }
  }
  game.restore(snap);
  if (stats) {
    stats.decisions++;
  }
  return best;
}
