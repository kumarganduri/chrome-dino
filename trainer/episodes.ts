// Episode definitions shared by the trainer, the gate and the server.
//
//   fresh  – a new game from `seed`, capped at `cap` frames (ramp + 10 min
//            at max speed during training; ramp + 30 min in the gate)
//   case   – a curriculum case: restore the snapshot taken 3 s before a past
//            crash and survive `cap` (600) frames
import type {Snapshot} from '../src/engine/game.ts';

export const RAMP_FRAMES = 7000; // speed 6 → 13 at +0.001/frame
export const TRAIN_CAP = RAMP_FRAMES + 36_000;
export const GATE_CAP = RAMP_FRAMES + 108_000;
export const CASE_CAP = 600;
export const PRE_CRASH_FRAMES = 180;
export const GATE_SEED_BASE = 1_000_000_000;

export type Episode =
  | {kind: 'fresh'; seed: number; cap: number}
  | {kind: 'case'; id: string; snapshot: Snapshot; cap: number};

export interface CrashRecord {
  frame: number; // frames survived in the episode
  speed: number;
  obstacles: string; // e.g. "cactusLarge3@90 pterodactyl1@100"
  signature: string;
  snapshot: Snapshot; // PRE_CRASH_FRAMES before impact (or episode start)
}

export interface EpisodeResult {
  frames: number;
  survived: boolean;
  crash?: CrashRecord;
}
