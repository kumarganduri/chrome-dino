// Deterministic workload for cross-engine checks. Runs the rule oracle with
// periodic forced fast-falls and ducks (so every key path is exercised) and
// folds per-frame fingerprints:
//   stateFold – coreHash() of every frame (world + dino + rng call count)
//   senseFold – the sense vector every frame (what a brain would see)
//   edgeFold  – frame numbers where a key goes down or up
// Checkpoints every 500 frames let a mismatch be located quickly.
import {Game} from './game.ts';
import {Hasher} from '../hook/hash.ts';
import {sense, SENSE_SIZE} from '../hook/sense.ts';
import {oracleKeys, DEFAULT_ORACLE} from '../oracle/oracle.ts';
import type {Keys} from '../hook/act.ts';

export interface DriveResult {
  seed: number;
  frames: number;
  crashed: boolean;
  stateFold: number;
  senseFold: number;
  edgeFold: number;
  checkpoints: number[];
}

export function drive(engine: any, seed: number, maxFrames: number, game?: Game): DriveResult {
  const g = game ?? Game.create(engine, seed);
  const state = new Hasher();
  const senses = new Hasher();
  const edges = new Hasher();
  const buf = new Float64Array(SENSE_SIZE);
  const checkpoints: number[] = [];
  let prev: Keys = {jump: false, down: false};
  while (g.frame < maxFrames && !g.crashed) {
    const k = oracleKeys(g.runner, DEFAULT_ORACLE);
    // Exercise free hops, speed drops and ducks only on an open road
    // (nothing within 420px), so the oracle still survives long runs.
    const t = g.runner.tRex;
    const open = g.runner.horizon.obstacles.every((o: any) => o.xPos + o.width < t.xPos || o.xPos - t.xPos > 420);
    const phase = g.frame % 240;
    const forced: Keys =
        !open ? k :
        phase < 8 ? {jump: true, down: false} :
        phase >= 20 && phase < 40 && t.jumping ? {jump: false, down: true} :
        phase >= 120 && phase < 135 && !t.jumping ? {jump: false, down: true} :
        k;
    sense(g.runner, buf);
    for (let i = 0; i < SENSE_SIZE; i++) senses.num(buf[i]!);
    if (forced.jump !== prev.jump) edges.int(g.frame).int(forced.jump ? 1 : 2);
    if (forced.down !== prev.down) edges.int(g.frame).int(forced.down ? 3 : 4);
    prev = forced;
    g.step(forced);
    state.int(g.coreHash());
    if (g.frame % 500 === 0) checkpoints.push(state.digest());
  }
  return {seed, frames: g.frame, crashed: g.crashed, stateFold: state.digest(), senseFold: senses.digest(),
    edgeFold: edges.digest(), checkpoints};
}
