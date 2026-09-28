// Runs NEAT genomes on episodes inside a worker. Each worker keeps one Game
// and resets it by snapshot restore (start snapshots are cached per seed).
import type {Engine} from '../src/engine/load.ts';
import {Game, type Snapshot} from '../src/engine/game.ts';
import {Network, type Genome} from '../src/neat/genome.ts';
import {BrainPolicy} from '../src/neat/policy.ts';
import {PRE_CRASH_FRAMES, type CrashRecord, type Episode, type EpisodeResult} from './episodes.ts';

let game: Game | null = null;
const starts = new Map<number, Snapshot>();

function gameFor(engine: Engine): Game {
  return (game ??= Game.create(engine, 0));
}

function startSnapshot(engine: Engine, seed: number): Snapshot {
  let s = starts.get(seed);
  if (!s) {
    if (starts.size > 4096) starts.clear();
    s = Game.create(engine, seed).snapshot();
    starts.set(seed, s);
  }
  return s;
}

function describe(g: Game): {obstacles: string; signature: string} {
  const r = g.runner;
  const ahead = r.horizon.obstacles.slice(0, 3);
  const obstacles = ahead.map((o: any) => `${o.typeConfig.type}${o.size}@${o.yPos}`).join(' ');
  const speedBucket = Math.round(r.currentSpeed * 2) / 2;
  const gaps = ahead.map((o: any) => Math.round(o.gap / 40)).join(',');
  return {obstacles, signature: `${obstacles}|s${speedBucket}|g${gaps}`};
}

export function runEpisode(engine: Engine, policy: BrainPolicy, ep: Episode, record: boolean): EpisodeResult {
  const g = gameFor(engine);
  const start = ep.kind === 'fresh' ? startSnapshot(engine, ep.seed) : ep.snapshot;
  g.restore(start);
  const startFrame = g.frame;
  while (g.frame - startFrame < ep.cap) {
    if (!g.step(policy.keys(g.runner))) break;
  }
  const frames = g.frame - startFrame;
  const survived = !g.crashed;
  if (survived || !record) {
    return {frames, survived};
  }
  const crashFrame = g.frame;
  const {obstacles, signature} = describe(g);
  const speed = g.runner.currentSpeed;
  // Deterministic: replay to 3 s before impact and snapshot there.
  g.restore(start);
  const target = Math.max(startFrame, crashFrame - PRE_CRASH_FRAMES);
  while (g.frame < target && g.step(policy.keys(g.runner))) {}
  const crash: CrashRecord = {frame: frames, speed, obstacles, signature, snapshot: g.snapshot()};
  return {frames, survived, crash};
}

export interface EvalTask {
  kind: 'eval';
  genomes: Genome[];
  episodes: Episode[];
  record?: boolean;
}

export function handleEval(engine: Engine, task: EvalTask): EpisodeResult[][] {
  return task.genomes.map((genome) => {
    const policy = new BrainPolicy(new Network(genome));
    return task.episodes.map((ep) => runEpisode(engine, policy, ep, !!task.record));
  });
}
