// Page runtime shared by every view: sprite loading, fixed-step clocks,
// ghost drawing with Chrome's own Trex.draw, and number formatting.
import {engine, Game} from '../src/web/core.ts';

export {engine, Game};

export const FRAME_MS = 1000 / 60;
export const SPRITE_URL = 'sprites/100-offline-sprite.png';

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

/** A 600×150 logical canvas, backed at devicePixelRatio for crisp pixels. */
export function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  canvas.width = 600;
  canvas.height = 150;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/**
 * Runs `step` at exactly 60 steps per game-second, driven by rAF. `speed`
 * multiplies steps per real second (×1, ×4, ×16…). Catches up at most
 * `maxSteps` per animation frame so a background tab never freezes the page.
 */
export class FixedLoop {
  speed = 1;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private readonly step: () => boolean | void;
  private readonly render: () => void;
  private readonly maxSteps: number;

  constructor(step: () => boolean | void, render: () => void, maxSteps = 240) {
    this.step = step;
    this.render = render;
    this.maxSteps = maxSteps;
  }

  start(): void {
    this.last = performance.now();
    const tick = (now: number) => {
      this.acc += Math.min(250, now - this.last) * this.speed;
      this.last = now;
      let n = 0;
      while (this.acc >= FRAME_MS && n < this.maxSteps) {
        this.acc -= FRAME_MS;
        n++;
        if (this.step() === false) {
          this.acc = 0;
          break;
        }
      }
      if (n === this.maxSteps) this.acc = 0;
      this.render();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }
}

const tintCache = new Map<string, HTMLCanvasElement>();

/** The sprite sheet recolored (for species colors). */
export function tintedSprite(sprite: HTMLImageElement, color: string): HTMLCanvasElement {
  let c = tintCache.get(color);
  if (!c) {
    c = document.createElement('canvas');
    c.width = sprite.width;
    c.height = sprite.height;
    const x = c.getContext('2d')!;
    x.drawImage(sprite, 0, 0);
    x.globalCompositeOperation = 'source-atop';
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    tintCache.set(color, c);
  }
  return c;
}

/**
 * Draws a game's T-Rex onto `ctx` using Chrome's own Trex.draw, by pointing
 * its context and sprite provider at the visible canvas for one call.
 */
export function drawTrex(game: Game, ctx: CanvasRenderingContext2D, sheet: CanvasImageSource, alpha: number): void {
  const t = game.runner.tRex;
  const savedCtx = t.canvasCtx;
  const savedProvider = t.resourceProvider;
  t.canvasCtx = ctx;
  t.resourceProvider = {getRunnerImageSprite: () => sheet};
  ctx.save();
  ctx.globalAlpha = alpha;
  try {
    t.draw(t.currentAnimFrames[t.currentFrame] ?? 0, 0);
  } finally {
    ctx.restore();
    t.canvasCtx = savedCtx;
    t.resourceProvider = savedProvider;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return d > 0 ? `${d}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Chrome's distance meter shows distanceRan × 0.025 (distance_meter.ts). */
export function scoreOf(game: Game): number {
  return Math.round(game.runner.distanceMeter.getActualDistance(Math.ceil(game.runner.distanceRan)));
}

export function $(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

/**
 * Draws a headless game's world (ground, moon/stars, clouds, obstacles) onto
 * `ctx` with Chrome's own draw methods, in Horizon.update's order. Each
 * object's context and sprite source are pointed at the page for one call.
 * Presentation only: no game state changes.
 */
export function drawWorld(game: Game, ctx: CanvasRenderingContext2D, sprite: CanvasImageSource): void {
  const h = game.runner.horizon;
  const provider = Object.create(game.runner, {
    getRunnerImageSprite: {value: () => sprite},
    getOrigImageSprite: {value: () => sprite},
  });
  const drawWith = (obj: any) => {
    const saved = {c: obj.canvasCtx, p: obj.imageSpriteProvider, r: obj.resourceProvider, i: obj.imageSprite};
    obj.canvasCtx = ctx;
    if ('imageSpriteProvider' in obj) obj.imageSpriteProvider = provider;
    if ('resourceProvider' in obj) obj.resourceProvider = provider;
    if ('imageSprite' in obj) obj.imageSprite = sprite;
    try {
      obj.draw();
    } finally {
      obj.canvasCtx = saved.c;
      if ('imageSpriteProvider' in obj) obj.imageSpriteProvider = saved.p;
      if ('resourceProvider' in obj) obj.resourceProvider = saved.r;
      if ('imageSprite' in obj) obj.imageSprite = saved.i;
    }
  };
  ctx.clearRect(0, 0, 600, 150);
  for (const line of h.horizonLines) drawWith(line);
  if (h.nightMode.opacity > 0) drawWith(h.nightMode);
  for (const cloud of h.clouds) drawWith(cloud);
  for (const o of h.obstacles) drawWith(o);
}
