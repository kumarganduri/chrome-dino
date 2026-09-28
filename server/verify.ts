// Server-side re-play. Nothing a client claims is trusted: every attack,
// race and champion candidate is re-simulated here from (seed, inputs).
//
//   replayRace(seed, inputs)                → frames survived, score
//   stateAtFrame(run, frame)                → the live run's exact state at a frame
//   replayAttack(run, forkFrame, drops)     → kill | survived | illegal | unclearable
//   verifyGate(genome, seeds)               → how many seeds it survives (30 min each)
import type {Engine} from '../src/engine/load.ts';
import {Game, type Snapshot} from '../src/engine/game.ts';
import {BrainPolicy} from '../src/neat/policy.ts';
import {Network, validateGenome, type Genome} from '../src/neat/genome.ts';
import {queueDrop, dropCheck, type Drop} from '../src/hook/attack.ts';
import {plannerKeys} from '../src/oracle/planner.ts';
import type {Keys} from '../src/hook/act.ts';
import {GATE_CAP} from '../trainer/episodes.ts';

export const RACE_MAX_FRAMES = 60 * 60 * 30;
export const ATTACK_MAX_FRAMES = 60 * 60;
export const ATTACK_MAX_DROPS = 10;
export const MAX_INPUTS = 20_000;
const PRE_CRASH = 180;

export interface RaceInput {
  f: number;
  k: 'jump' | 'down';
  d: 0 | 1;
}

export function validateRaceInputs(inputs: unknown): RaceInput[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) throw new Error('invalid inputs');
  let last = -1;
  return inputs.map((x: any) => {
    if (!x || !Number.isInteger(x.f) || x.f < last || x.f < 0 || x.f > RACE_MAX_FRAMES ||
        (x.k !== 'jump' && x.k !== 'down') || (x.d !== 0 && x.d !== 1)) {
      throw new Error('invalid input event');
    }
    last = x.f;
    return {f: x.f, k: x.k, d: x.d};
  });
}

export function replayRace(engine: Engine, seed: number, inputs: RaceInput[]): {frames: number; score: number} {
  const g = Game.create(engine, seed >>> 0);
  const keys: Keys = {jump: false, down: false};
  let i = 0;
  while (g.frame < RACE_MAX_FRAMES) {
    while (i < inputs.length && inputs[i]!.f <= g.frame) {
      keys[inputs[i]!.k] = inputs[i]!.d === 1;
      i++;
    }
    if (!g.step({...keys})) break;
  }
  const score = Math.round(g.runner.distanceMeter.getActualDistance(Math.ceil(g.runner.distanceRan)));
  return {frames: g.frame, score};
}

export interface RunRecord {
  seed: number;
  segments: Array<{fromFrame: number; genome: Genome; checkpoint: Snapshot | null}>;
}

/** The live run's state at `frame`: nearest checkpoint, then replay the brain. */
export function stateAtFrame(engine: Engine, run: RunRecord, checkpoints: Snapshot[], frame: number): {game: Game; genome: Genome} {
  const best = checkpoints.filter((c) => c.frame <= frame).sort((a, b) => b.frame - a.frame)[0] ?? null;
  const g = Game.create(engine, run.seed);
  if (best) g.restore(best);
  const segmentFor = (f: number) => [...run.segments].reverse().find((s) => s.fromFrame <= f) ?? run.segments[0]!;
  let seg = segmentFor(g.frame);
  let policy = new BrainPolicy(new Network(seg.genome));
  while (g.frame < frame) {
    const next = segmentFor(g.frame);
    if (next !== seg) {
      seg = next;
      policy = new BrainPolicy(new Network(seg.genome));
    }
    if (!g.step(policy.keys(g.runner))) break;
  }
  return {game: g, genome: seg.genome};
}

export type AttackVerdict =
  | {verdict: 'kill'; frame: number; obstacles: string; speed: number; snapshot: Snapshot}
  | {verdict: 'survived'}
  | {verdict: 'illegal'; reason: string}
  | {verdict: 'unclearable'; reason: string};

export function validateDrops(drops: unknown, forkFrame: number): Array<Drop & {frame: number}> {
  if (!Array.isArray(drops) || drops.length > ATTACK_MAX_DROPS) throw new Error(`at most ${ATTACK_MAX_DROPS} drops`);
  let last = forkFrame - 1;
  return drops.map((d: any) => {
    const ok = d && Number.isInteger(d.frame) && d.frame > last && d.frame <= forkFrame + ATTACK_MAX_FRAMES &&
        ['cactusSmall', 'cactusLarge', 'pterodactyl'].includes(d.type) &&
        (d.yPos === undefined || [100, 75, 50].includes(d.yPos));
    if (!ok) throw new Error('invalid drop');
    last = d.frame;
    return d.yPos === undefined ? {type: d.type, frame: d.frame} : {type: d.type, yPos: d.yPos, frame: d.frame};
  });
}

function runAttack(start: Game, drops: Array<Drop & {frame: number}>, keysFor: (g: Game) => Keys, until: number):
    {game: Game; illegal: string | null; ring: Snapshot[]} {
  const g = start;
  let di = 0;
  const ring: Snapshot[] = [];
  while (g.frame < until) {
    while (di < drops.length && drops[di]!.frame <= g.frame) {
      const d = drops[di++]!;
      const reason = dropCheck(g, d);
      if (reason) return {game: g, illegal: reason, ring};
      if (!queueDrop(g, d)) return {game: g, illegal: 'a drop was queued while another was pending', ring};
    }
    if (g.frame % 60 === 0) {
      ring.push(g.snapshot());
      if (ring.length > 6) ring.shift();
    }
    if (!g.step(keysFor(g))) break;
  }
  return {game: g, illegal: null, ring};
}

export function replayAttack(engine: Engine, run: RunRecord, checkpoints: Snapshot[], forkFrame: number,
    drops: Array<Drop & {frame: number}>): AttackVerdict {
  const {game, genome} = stateAtFrame(engine, run, checkpoints, forkFrame);
  if (game.crashed || game.frame !== forkFrame) return {verdict: 'illegal', reason: 'fork frame is not part of the live run'};
  const forkSnap = game.snapshot();
  const policy = new BrainPolicy(new Network(genome));
  const until = forkFrame + ATTACK_MAX_FRAMES;
  const champ = runAttack(game, drops, (g) => policy.keys(g.runner), until);
  if (champ.illegal) return {verdict: 'illegal', reason: champ.illegal};
  if (!champ.game.crashed) return {verdict: 'survived'};
  const crashFrame = champ.game.frame;
  // Was it survivable at all? The lookahead oracle faces the same drops.
  const oracleGame = Game.create(engine, 0);
  oracleGame.restore(forkSnap);
  const oracle = runAttack(oracleGame, drops, (g) => plannerKeys(g), Math.min(until, crashFrame + 180));
  if (oracle.game.crashed) {
    return {verdict: 'unclearable', reason: 'no player could have survived that sequence'};
  }
  const r = champ.game.runner;
  const snapshot = champ.ring.find((s) => s.frame <= crashFrame - PRE_CRASH) ?? champ.ring[0] ?? forkSnap;
  return {
    verdict: 'kill', frame: crashFrame, speed: r.currentSpeed, snapshot,
    obstacles: r.horizon.obstacles.slice(0, 3).map((o: any) => `${o.typeConfig.type}${o.size}@${o.yPos}`).join(' '),
  };
}

export function verifyGate(engine: Engine, genomeRaw: unknown, seeds: number[]): {genome: Genome; passed: number; failedSeeds: number[]} {
  const genome = validateGenome(genomeRaw);
  const policy = new BrainPolicy(new Network(genome));
  const failedSeeds: number[] = [];
  for (const seed of seeds) {
    const g = Game.create(engine, seed);
    while (g.frame < GATE_CAP && g.step(policy.keys(g.runner))) {}
    if (g.crashed) failedSeeds.push(seed);
  }
  return {genome, passed: seeds.length - failedSeeds.length, failedSeeds};
}
