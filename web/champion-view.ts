// The hero: Chrome's real game, drawn by Chrome's own code into a visible
// canvas, played by the champion brain at 60 steps/s.
//
//   local mode: a fresh seed per run; the clock is this run's game time
//   live mode:  (seed, startEpoch, checkpoint) from the server; the page
//               restores the checkpoint and fast-forwards to "now", so every
//               visitor watches the same run (see web/live.ts)
import {BrainPolicy, Network, type Genome} from '../src/web/core.ts';
import {Game, engine, FixedLoop, FRAME_MS, formatDuration, formatInt, scoreOf} from './runtime.ts';
import type {Snapshot} from '../src/engine/game.ts';

export interface ChampionInfo {
  version: number | null; // null = not yet gate-proven (leader)
  genome: Genome;
  label: string;
}

export interface CrashEvent {
  seed: number;
  frames: number;
  score: number;
  speed: number;
  obstacles: string;
  snapshot: Snapshot; // 3 s before impact
  genome: Genome;
  source: 'live' | 'local';
}

export interface RunSpec {
  seed: number;
  startWall: number; // wall-clock ms (Date.now) when frame 0 happened
  checkpoint?: Snapshot | null;
}

const RING_EVERY = 60;
const RING_SIZE = 8;

export class ChampionView {
  game!: Game;
  policy!: BrainPolicy;
  champion!: ChampionInfo;
  run!: RunSpec;
  onCrash: (e: CrashEvent) => void = () => {};
  onFrame: () => void = () => {};
  private readonly canvas: HTMLCanvasElement;
  private readonly sprite: HTMLImageElement;
  private readonly loop: FixedLoop;
  private ring: Snapshot[] = [];
  private crashedAt = 0;
  private restartTimer = 0;
  nextSeed: () => RunSpec = () => ({seed: randomSeed(), startWall: Date.now()});

  constructor(canvas: HTMLCanvasElement, sprite: HTMLImageElement) {
    this.canvas = canvas;
    this.sprite = sprite;
    this.loop = new FixedLoop(() => this.step(), () => this.render(), 600);
  }

  start(champion: ChampionInfo, run: RunSpec): void {
    this.champion = champion;
    this.policy = new BrainPolicy(new Network(champion.genome));
    this.begin(run);
    this.loop.start();
  }

  setChampion(champion: ChampionInfo): void {
    this.champion = champion;
    this.policy = new BrainPolicy(new Network(champion.genome));
  }

  /** Start (or join) a run; fast-forwards headlessly to the current frame. */
  begin(run: RunSpec): void {
    clearTimeout(this.restartTimer);
    this.run = run;
    this.crashedAt = 0;
    this.ring = [];
    this.game = Game.create(engine, run.seed, {canvas: this.canvas, image: this.sprite});
    if (run.checkpoint) this.game.restore(run.checkpoint);
    this.catchUp();
  }

  /** Frames the live run should be at, by wall clock. */
  private targetFrame(): number {
    return Math.floor((Date.now() - this.run.startWall) / FRAME_MS);
  }

  private catchUp(): void {
    // Bounded catch-up (a hidden tab resuming, or joining mid-run).
    const target = this.targetFrame();
    let budget = 60 * 90;
    while (this.game.frame < target - 1 && budget-- > 0 && !this.game.crashed) this.stepOnce();
    if (this.game.frame < target - 1) {
      // Too far behind to replay here (no fresh checkpoint): re-anchor the clock.
      this.run = {...this.run, startWall: Date.now() - this.game.frame * FRAME_MS};
    }
  }

  private stepOnce(): void {
    if (this.game.frame % RING_EVERY === 0) {
      this.ring.push(this.game.snapshot());
      if (this.ring.length > RING_SIZE) this.ring.shift();
    }
    const alive = this.game.step(this.policy.keys(this.game.runner));
    if (!alive) this.handleCrash();
  }

  private step(): boolean {
    if (this.game.crashed) return false;
    if (this.game.frame >= this.targetFrame() + 2) return true; // ahead of wall clock: hold
    this.stepOnce();
    return true;
  }

  private handleCrash(): void {
    this.crashedAt = Date.now();
    const g = this.game;
    const r = g.runner;
    const pre = this.ring.find((s) => s.frame >= g.frame - 240 && s.frame <= g.frame - 170) ?? this.ring[0]!;
    this.onCrash({
      seed: this.run.seed, frames: g.frame, score: scoreOf(g), speed: r.currentSpeed,
      obstacles: r.horizon.obstacles.slice(0, 3).map((o: any) => `${o.typeConfig.type}${o.size}@${o.yPos}`).join(' '),
      snapshot: pre, genome: this.champion.genome, source: this.run.checkpoint !== undefined ? 'live' : 'local',
    });
    this.restartTimer = window.setTimeout(() => this.begin(this.nextSeed()), 2500);
  }

  get timeSinceCrashMs(): number {
    return this.game.frame * FRAME_MS;
  }

  get justCrashed(): boolean {
    return this.crashedAt > 0;
  }

  private render(): void {
    const r = this.game.runner;
    this.canvas.parentElement!.classList.toggle('night', !!r.inverted);
    this.canvas.parentElement!.classList.toggle('crashed', this.game.crashed);
    this.onFrame();
  }

  stats() {
    const r = this.game.runner;
    return {
      clock: formatDuration(this.timeSinceCrashMs),
      score: formatInt(scoreOf(this.game)),
      speed: r.currentSpeed.toFixed(2),
      maxSpeed: r.config.maxSpeed,
      frame: formatInt(this.game.frame),
      seed: '0x' + (this.run.seed >>> 0).toString(16).padStart(8, '0'),
    };
  }
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
