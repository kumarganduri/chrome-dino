// The two interactive modes, shared dialog.
//
// Try to kill it: fork the champion's game at this very frame, let the visitor
//   choose what Chrome spawns next (≤10 drops), play 60 s. A crash is a claimed
//   kill; the server re-plays (fork frame, drops) and checks the obstacle
//   sequence was clearable before crediting it.
// Race it: visitor and a ghost of the champion on the same seed. Space/↑ jump,
//   ↓ duck (touch: tap top half = jump, bottom half = duck). Inputs are logged
//   per frame and re-played by the server for the board.
import {BrainPolicy, Network, installAttackHook, queueDrop, dropCheck, type Genome} from '../src/web/core.ts';
import {Game, engine, FixedLoop, drawTrex, drawWorld, tintedSprite, scoreOf, FRAME_MS, formatDuration} from './runtime.ts';
import type {Keys} from '../src/hook/act.ts';
import type {Drop} from '../src/hook/attack.ts';
import type {LiveClient} from './live.ts';

const DROP_BUDGET = 10;
const ATTACK_FRAMES = 60 * 60;

export interface PlayContext {
  sprite: HTMLImageElement;
  championGame: () => Game;
  championGenome: () => Genome;
  championVersion: () => number | null;
  liveRunId: () => {seed: number; championVersion: number} | null;
  live: LiveClient | null;
  onKill: (k: {name: string; obstacles: string; speed: number; verified: boolean; snapshot: any; genome: Genome}) => void;
  onRace: (r: {name: string; seconds: number; score: number; verified: boolean}) => void;
}

export class PlayDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly status: HTMLElement;
  private readonly palette: HTMLElement;
  private readonly handle: HTMLInputElement;
  private readonly ctxp: PlayContext;
  private loop: FixedLoop | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(ctxp: PlayContext) {
    this.ctxp = ctxp;
    this.dialog = document.getElementById('play') as HTMLDialogElement;
    this.canvas = document.getElementById('play-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.status = document.getElementById('play-status')!;
    this.palette = document.getElementById('palette')!;
    this.handle = document.getElementById('handle') as HTMLInputElement;
    try {
      this.handle.value = localStorage.getItem('dino.handle') ?? '';
    } catch {}
    this.handle.addEventListener('change', () => {
      try {
        localStorage.setItem('dino.handle', this.handle.value);
      } catch {}
    });
    this.dialog.addEventListener('close', () => this.stop());
    installAttackHook(engine);
  }

  private name(): string {
    return this.handle.value.trim().slice(0, 16) || 'anonymous';
  }

  private stop(): void {
    this.loop?.stop();
    this.loop = null;
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler);
      window.removeEventListener('keyup', this.keyHandler);
      this.keyHandler = null;
    }
    this.canvas.onpointerdown = this.canvas.onpointerup = null;
  }

  // ─── Try to kill it ────────────────────────────────────────────────────
  attack(): void {
    this.stop();
    const source = this.ctxp.championGame();
    const forkFrame = source.frame;
    const game = Game.create(engine, 0);
    game.restore(source.snapshot());
    const genome = this.ctxp.championGenome();
    const policy = new BrainPolicy(new Network(genome));
    const run = this.ctxp.liveRunId();
    const drops: Array<Drop & {frame: number}> = [];
    let done = false;
    (document.getElementById('play-title')!).textContent = 'Try to kill it';
    (document.getElementById('play-help')!).textContent =
        'Each obstacle you pick replaces Chrome’s next spawn. Chrome still decides the gaps and cactus cluster size. 10 drops, 60 seconds.';
    this.palette.hidden = false;
    const update = () => {
      const left = DROP_BUDGET - drops.length;
      const t = formatDuration((game.frame - forkFrame) * FRAME_MS);
      if (!done) this.status.textContent = `${left} drop${left === 1 ? '' : 's'} left · ${t} of 01:00 · speed ${game.runner.currentSpeed.toFixed(2)}`;
      for (const b of this.palette.querySelectorAll<HTMLButtonElement>('button')) {
        const drop = dropOf(b);
        const reason = dropCheck(game, drop);
        b.disabled = done || left <= 0 || reason !== null || (game.runner.horizon.attackQueue?.length ?? 0) > 0;
        b.title = reason ?? 'Spawn this next';
        b.classList.toggle('queued', (game.runner.horizon.attackQueue ?? []).some((q: Drop) => q.type === drop.type && q.yPos === drop.yPos));
      }
    };
    this.palette.onclick = (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b || done || drops.length >= DROP_BUDGET) return;
      const drop = dropOf(b as HTMLButtonElement);
      if (dropCheck(game, drop) !== null) return;
      if (queueDrop(game, drop)) drops.push({...drop, frame: game.frame});
      update();
    };
    const finish = async (killed: boolean) => {
      done = true;
      const r = game.runner;
      const obstacles = r.horizon.obstacles.slice(0, 3).map((o: any) => `${o.typeConfig.type}${o.size}@${o.yPos}`).join(' ');
      this.status.textContent = killed ? 'You crashed it! Verifying with the server…' :
        `It survived all ${drops.length} of your drops.`;
      let verified = false;
      let snapshot: any = null;
      if (this.ctxp.live && run) {
        // Every attack is re-played server-side: survivals count too.
        try {
          const res = await this.ctxp.live.post<{verdict: string; reason?: string; snapshot?: any}>('/api/attack', {
            seed: run.seed, championVersion: run.championVersion, forkFrame, drops, name: this.name(),
          });
          verified = res.verdict === 'kill';
          snapshot = res.snapshot ?? null;
          if (killed) {
            this.status.textContent = verified ?
              'Verified kill. It is on the board, and the champion is now training on it.' :
              `Not counted: ${res.reason ?? res.verdict}.`;
          } else {
            this.status.textContent += res.verdict === 'survived' ? ' Logged on the board. Try again?' : ` (${res.reason ?? res.verdict})`;
          }
        } catch (e) {
          this.status.textContent += ` (Could not verify: ${(e as Error).message})`;
        }
      } else if (killed) {
        this.status.textContent = 'You crashed it! (Offline: counted in this tab only.)';
      }
      if (killed) this.ctxp.onKill({name: this.name(), obstacles, speed: r.currentSpeed, verified, snapshot, genome});
    };
    this.loop = new FixedLoop(() => {
      if (done) return false;
      if (!game.step(policy.keys(game.runner))) {
        void finish(true);
        return false;
      }
      if (game.frame - forkFrame >= ATTACK_FRAMES) {
        void finish(false);
        return false;
      }
      return true;
    }, () => {
      drawWorld(game, this.ctx, this.ctxp.sprite);
      drawTrex(game, this.ctx, this.ctxp.sprite, 1);
      this.canvas.parentElement!.classList.toggle('crashed', game.crashed);
      update();
    });
    this.dialog.showModal();
    this.loop.start();
  }

  // ─── Race it ───────────────────────────────────────────────────────────
  race(): void {
    this.stop();
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const human = Game.create(engine, seed);
    const ghost = Game.create(engine, seed);
    const genome = this.ctxp.championGenome();
    const policy = new BrainPolicy(new Network(genome));
    const keys: Keys = {jump: false, down: false};
    const inputs: Array<{f: number; k: 'jump' | 'down'; d: 0 | 1}> = [];
    let started = false;
    let done = false;
    (document.getElementById('play-title')!).textContent = 'Race it';
    (document.getElementById('play-help')!).textContent =
        'You vs a ghost of the champion, same track. Space or ↑ to jump, ↓ to duck. On touch: tap the top half to jump, bottom half to duck.';
    this.palette.hidden = true;
    this.status.textContent = 'Press Space (or tap) to start.';
    const set = (k: 'jump' | 'down', down: boolean) => {
      if (done) return;
      if (!started && k === 'jump' && down) started = true;
      if (keys[k] !== down) {
        keys[k] = down;
        inputs.push({f: human.frame, k, d: down ? 1 : 0});
      }
    };
    this.keyHandler = (e: KeyboardEvent) => {
      const down = e.type === 'keydown';
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        set('jump', down);
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        set('down', down);
      }
    };
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('keyup', this.keyHandler);
    this.canvas.onpointerdown = (e) => {
      const r = this.canvas.getBoundingClientRect();
      set((e.clientY - r.top) / r.height < 0.5 ? 'jump' : 'down', true);
    };
    this.canvas.onpointerup = () => {
      set('jump', false);
      set('down', false);
    };
    const finish = async () => {
      done = true;
      const seconds = human.frame / 60;
      const score = scoreOf(human);
      this.status.textContent = `You lasted ${seconds.toFixed(1)} s (score ${score}). The champion is still running.`;
      let verified = false;
      if (this.ctxp.live) {
        try {
          const res = await this.ctxp.live.post<{frames: number; score: number}>('/api/run', {seed, inputs, name: this.name()});
          verified = res.frames === human.frame;
          this.status.textContent += verified ? ' Verified and on the board.' : ' (Server replay disagreed; not counted.)';
        } catch (e) {
          this.status.textContent += ` (Could not submit: ${(e as Error).message})`;
        }
      }
      this.ctxp.onRace({name: this.name(), seconds, score, verified});
    };
    this.loop = new FixedLoop(() => {
      if (!started || done) return true;
      const alive = human.step({...keys});
      if (!ghost.crashed) ghost.step(policy.keys(ghost.runner));
      if (!alive) void finish();
      return true;
    }, () => {
      drawWorld(human, this.ctx, this.ctxp.sprite);
      if (!ghost.crashed) drawTrex(ghost, this.ctx, tintedSprite(this.ctxp.sprite, '#1a73e8'), 0.45);
      drawTrex(human, this.ctx, this.ctxp.sprite, 1);
      this.canvas.parentElement!.classList.toggle('crashed', human.crashed);
      if (started && !done) this.status.textContent = `${(human.frame / 60).toFixed(1)} s · score ${scoreOf(human)}`;
    });
    this.dialog.showModal();
    this.loop.start();
  }
}

function dropOf(b: HTMLButtonElement): Drop {
  const type = b.dataset.drop as Drop['type'];
  const y = b.dataset.y ? (Number(b.dataset.y) as 100 | 75 | 50) : undefined;
  return y === undefined ? {type} : {type, yPos: y};
}
