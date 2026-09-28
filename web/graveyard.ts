// Crash black box: every recorded crash as a card; clicking one restores the
// snapshot taken 3 s before impact and replays it with the same brain, so the
// crash happens again exactly, slowed down.
import {BrainPolicy, Network, type Genome} from '../src/web/core.ts';
import {Game, engine, FixedLoop, drawTrex, drawWorld} from './runtime.ts';
import type {Snapshot} from '../src/engine/game.ts';

export interface Grave {
  id: string;
  title: string; // "gen 12", "kill #4", "live run"
  source: 'training' | 'gate' | 'live' | 'swarm' | 'attack' | 'local';
  obstacles: string;
  speed: number;
  score?: number;
  snapshot?: Snapshot;
  genome?: Genome;
}

const ICON: Record<string, string> = {cactusSmall: '🌵', cactusLarge: '🌵', pterodactyl: '🦅'};

export function obstacleIcons(obstacles: string): string {
  return obstacles.split(' ').filter(Boolean).slice(0, 2).map((o) => {
    const m = o.match(/^([a-zA-Z]+)(\d)@(\d+)/);
    if (!m) return '';
    const [, type, size, y] = m;
    if (type === 'pterodactyl') return `${ICON.pterodactyl}${y === '50' ? '↑' : y === '75' ? '→' : '↓'}`;
    return (ICON[type!] ?? '?').repeat(Number(size));
  }).join(' ');
}

export class Graveyard {
  private readonly list: HTMLElement;
  private readonly replayCanvas: HTMLCanvasElement;
  private readonly replayCaption: HTMLElement;
  private readonly sprite: HTMLImageElement;
  private graves: Grave[] = [];
  private replay: {game: Game; policy: BrainPolicy; end: number} | null = null;
  private readonly loop: FixedLoop;

  constructor(list: HTMLElement, replayCanvas: HTMLCanvasElement, caption: HTMLElement, sprite: HTMLImageElement) {
    this.list = list;
    this.replayCanvas = replayCanvas;
    this.replayCaption = caption;
    this.sprite = sprite;
    this.loop = new FixedLoop(() => this.step(), () => this.render(), 4);
    this.loop.speed = 0.5;
    this.loop.start();
  }

  add(g: Grave, front = true): void {
    if (this.graves.some((x) => x.id === g.id)) return;
    if (front) this.graves.unshift(g);
    else this.graves.push(g);
    if (this.graves.length > 120) this.graves.length = 120;
    this.renderList();
  }

  private renderList(): void {
    this.list.replaceChildren(...this.graves.map((g) => {
      const b = document.createElement('button');
      b.className = `tomb tomb-${g.source}`;
      b.type = 'button';
      b.disabled = !g.snapshot || !g.genome;
      b.title = g.snapshot ? 'Replay the 3 seconds before this crash' : 'No replay data';
      b.innerHTML = `<span class="tomb-title"></span><span class="tomb-icons"></span><span class="tomb-meta"></span>`;
      b.querySelector('.tomb-title')!.textContent = g.title;
      b.querySelector('.tomb-icons')!.textContent = obstacleIcons(g.obstacles) || '·';
      b.querySelector('.tomb-meta')!.textContent = g.score !== undefined ? `score ${g.score}` : `speed ${g.speed.toFixed(1)}`;
      b.addEventListener('click', () => this.play(g));
      return b;
    }));
  }

  play(g: Grave): void {
    if (!g.snapshot || !g.genome) return;
    const game = Game.create(engine, 0);
    game.restore(g.snapshot);
    this.replay = {game, policy: new BrainPolicy(new Network(g.genome)), end: game.frame + 600};
    this.replayCaption.textContent = `${g.title} · replaying the 3 s before impact at ½ speed · ${g.obstacles.replace(/@\d+/g, '')}`;
    this.replayCanvas.closest('.replay')?.removeAttribute('hidden');
  }

  private step(): boolean {
    const r = this.replay;
    if (!r) return true;
    if (r.game.crashed || r.game.frame > r.end) return true;
    r.game.step(r.policy.keys(r.game.runner));
    return true;
  }

  private render(): void {
    const r = this.replay;
    if (!r) return;
    const ctx = this.replayCanvas.getContext('2d')!;
    drawWorld(r.game, ctx, this.sprite);
    drawTrex(r.game, ctx, this.sprite, 1);
    this.replayCanvas.parentElement!.classList.toggle('crashed', r.game.crashed);
  }
}
