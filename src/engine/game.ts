// One deterministic game of Chrome's dino, driven by the unedited Runner.
//
//   Game.create(engine, seed)
//     └─ new Runner()  ── headless init (mirrors Runner.init order):
//          Horizon → DistanceMeter → Trex → update()      [consumes seeded RNG]
//     └─ startRun(): activated + playing, intro skipped
//
//   game.step(keys)            one fixed 1/60 s frame:
//     clock += 1000/60
//     applyKeys(prev, keys)    same calls as Runner.onKeyDown/onKeyUp
//     runner.update()          Chrome's real per-frame loop
//
// Everything random goes through this game's Rng, and the only clock the game
// sees is `clock.now`, so (seed, key sequence) fully determines the run.
import type {Engine} from './load.ts';
import {Rng} from '../hook/rng.ts';
import {withGameGlobals, type GameClock} from '../hook/env.ts';
import {applyKeys, NO_KEYS, type Keys} from '../hook/act.ts';
import {createNullCanvas, createNullImage} from '../hook/canvas-stub.ts';
import {Hasher, hashString} from '../hook/hash.ts';
import {deserialize, registerExtern, registerExterns, serialize, type Json, type SnapshotContext} from '../hook/snapshot.ts';

export const FRAME_MS = 1000 / 60;
export const SNAPSHOT_VERSION = 1;
// First timestamp. Non-zero because Runner.update treats time === 0 as "unset".
const CLOCK_START = 1000;

// Runner fields that are game state (everything else is DOM/audio/config).
const RUNNER_STATE_FIELDS = [
  'time', 'distanceRan', 'runningTime', 'currentSpeed', 'playCount', 'activated',
  'playing', 'playingIntro', 'crashed', 'paused', 'inverted', 'updatePending',
  'invertTimer', 'invertTrigger', 'highestScore', 'raqId', 'fadeInTimer',
  'altGameModeFlashTimer', 'altGameModeActive', 'isDarkMode', 'tRex', 'horizon',
  'distanceMeter',
] as const;

export interface GameSurface {
  canvas: object;
  image: object;
}

export interface Snapshot {
  v: number;
  frame: number;
  clock: number;
  rngState: number;
  rngCalls: number;
  prevKeys: Keys;
  state: Json;
}

export class Game {
  readonly runner: any;
  readonly rng: Rng;
  readonly clock: GameClock = {now: CLOCK_START};
  frame = 0;
  prevKeys: Keys = NO_KEYS;
  readonly engine: Engine;
  private readonly snapCtx: SnapshotContext;

  private constructor(engine: Engine, runner: any, rng: Rng, surface: GameSurface) {
    this.engine = engine;
    this.runner = runner;
    this.rng = rng;
    this.snapCtx = buildSnapshotContext(engine, runner, surface);
  }

  /** Headless game: null canvas, Chrome's Runner with a manual init. */
  static create(engine: Engine, seed: number): Game {
    const rng = new Rng(seed);
    const canvas = createNullCanvas(600, 150);
    const image = createNullImage();
    let runner: any;
    const clock = {now: CLOCK_START};
    withGameGlobals(rng, clock, () => {
      runner = new (engine.Runner as any)('#dino');
      runner.spriteDef = engine.spriteDefinitionByType.original.ldpi;
      runner.imageSprite = image;
      runner.origImageSprite = image;
      runner.canvas = canvas;
      runner.canvasCtx = canvas.getContext();
      runner.horizon = new engine.Horizon(
          canvas as any, runner.spriteDef, runner.dimensions, runner.config.gapCoefficient, runner);
      runner.distanceMeter = new engine.DistanceMeter(
          canvas as any, runner.spriteDef.textSprite, runner.dimensions.width, runner);
      runner.tRex = new engine.Trex(canvas as any, runner.spriteDef.tRex, runner);
      runner.update();
    });
    // Headless crash: keep Chrome's state changes, skip the panel/DOM/sound.
    runner.gameOver = function(this: any) {
      this.stop();
      this.crashed = true;
      this.distanceMeter.achievement = false;
      this.tRex.update(100, engine.TrexStatus.CRASHED);
      this.time = performance.now();
    };
    const game = new Game(engine, runner, rng, {canvas, image});
    game.clock.now = clock.now;
    game.startRun();
    return game;
  }

  /** Wrap an already-initialized Runner (the visible champion in a real page). */
  static adopt(engine: Engine, runner: any, rng: Rng, clock: GameClock, surface: GameSurface): Game {
    const game = new Game(engine, runner, rng, surface);
    game.clock.now = clock.now;
    game.startRun();
    return game;
  }

  private startRun(): void {
    const r = this.runner;
    withGameGlobals(this.rng, this.clock, () => {
      r.activated = true;
      r.playing = true;
      r.playingIntro = false;
      r.tRex.playingIntro = false;
      r.paused = false;
      r.crashed = false;
      r.runningTime = 0;
      r.playCount++;
      r.isDarkMode = false;
      r.tRex.update(0, this.engine.TrexStatus.RUNNING);
      r.time = this.clock.now;
    });
  }

  get crashed(): boolean {
    return this.runner.crashed;
  }

  step(keys: Keys = NO_KEYS): boolean {
    if (this.runner.crashed) {
      return false;
    }
    this.clock.now += FRAME_MS;
    this.frame++;
    const r = this.runner;
    withGameGlobals(this.rng, this.clock, () => {
      applyKeys(r, this.prevKeys, keys);
      r.update();
    });
    this.prevKeys = keys;
    return !r.crashed;
  }

  /** Cheap per-frame fingerprint of everything that decides survival. */
  coreHash(): number {
    const r = this.runner;
    const t = r.tRex;
    const h = new Hasher()
        .int(this.frame).int(this.rng.calls).int(this.rng.state)
        .num(r.currentSpeed).num(r.distanceRan).num(r.runningTime).bool(r.crashed).bool(r.inverted)
        .num(t.xPos).num(t.yPos).num(t.jumpVelocity).int(t.status.length).str(t.status)
        .bool(t.jumping).bool(t.ducking).bool(t.speedDrop);
    for (const o of r.horizon.obstacles) {
      h.str(o.typeConfig.type).num(o.xPos).num(o.yPos).int(o.size).num(o.gap).num(o.speedOffset);
    }
    return h.digest();
  }

  snapshot(): Snapshot {
    const roots: Record<string, unknown> = {};
    for (const f of RUNNER_STATE_FIELDS) {
      roots[f] = this.runner[f];
    }
    return {
      v: SNAPSHOT_VERSION,
      frame: this.frame,
      clock: this.clock.now,
      rngState: this.rng.state,
      rngCalls: this.rng.calls,
      prevKeys: {...this.prevKeys},
      state: serialize(this.snapCtx, roots),
    };
  }

  restore(snap: Snapshot): void {
    if (snap.v !== SNAPSHOT_VERSION) {
      throw new Error(`snapshot version ${snap.v} != engine snapshot version ${SNAPSHOT_VERSION}`);
    }
    const roots = deserialize(this.snapCtx, snap.state);
    for (const f of RUNNER_STATE_FIELDS) {
      this.runner[f] = roots[f];
    }
    this.frame = snap.frame;
    this.clock.now = snap.clock;
    this.rng.state = snap.rngState;
    this.rng.calls = snap.rngCalls;
    this.prevKeys = {...snap.prevKeys};
  }

  /** Hash of the complete state (every serialized field). */
  fullHash(): number {
    return hashString(JSON.stringify(this.snapshot()));
  }
}

function buildSnapshotContext(engine: Engine, runner: any, surface: GameSurface): SnapshotContext {
  const ctx: SnapshotContext = {externs: new Map(), externsById: new Map(), classes: new Map(), classesByTag: new Map()};
  const classes: Record<string, {prototype: object}> = {
    Trex: engine.Trex, Horizon: engine.Horizon, Obstacle: engine.Obstacle, Cloud: engine.Cloud,
    NightMode: engine.NightMode, HorizonLine: engine.HorizonLine, BackgroundEl: engine.BackgroundEl,
    DistanceMeter: engine.DistanceMeter, CollisionBox: engine.CollisionBox, GameOverPanel: engine.GameOverPanel,
  };
  for (const [tag, cls] of Object.entries(classes)) {
    ctx.classes.set(cls.prototype, tag);
    ctx.classesByTag.set(tag, cls.prototype);
  }
  registerExtern(ctx, 'runner', runner);
  registerExtern(ctx, 'canvas', surface.canvas);
  registerExtern(ctx, 'ctx', (surface.canvas as any).getContext('2d'));
  registerExtern(ctx, 'image', surface.image);
  registerExtern(ctx, 'dimensions', runner.dimensions);
  registerExterns(ctx, 'config', runner.config);
  registerExterns(ctx, 'sprites', engine.spriteDefinitionByType);
  registerExterns(ctx, 'bgConfig', engine.getBackgroundElConfig());
  // Module-level configs shared by every instance (never mutated during play).
  registerExterns(ctx, 'trexConfig', runner.tRex.config);
  registerExterns(ctx, 'horizonConfig', runner.horizon.config);
  registerExterns(ctx, 'meterConfig', runner.distanceMeter.config ?? {});
  return ctx;
}
