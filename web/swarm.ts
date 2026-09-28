// Ghost swarm: NEAT evolving live in the visitor's tab.
//
//   generation g: seed_g shared by all 150 genomes → 150 real Chrome games
//   on an identical track (obstacle generation never depends on the dino).
//   each step: every alive ghost senses → its network → keys → Runner.update
//   render: world of any alive ghost (drawWorld) + every ghost's T-Rex
//           (drawTrex), tinted by species; fallen ghosts fade out
//   all dead → population.advance(frames survived) → generation g+1
import {BrainPolicy, Network, Population, DEFAULT_NEAT} from '../src/web/core.ts';
import {Game, engine, FixedLoop, drawTrex, drawWorld, tintedSprite, scoreOf, formatInt} from './runtime.ts';
import type {Genome} from '../src/neat/genome.ts';

const SPECIES_COLORS = ['#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6', '#12b5cb', '#f9ab00', '#e52592', '#5f6368', '#7cb342'];
const GEN_CAP_FRAMES = 60 * 60 * 3; // a generation ends after 3 min of game time

interface Ghost {
  game: Game;
  policy: BrainPolicy;
  memberIndex: number;
  species: number;
  diedAt: number; // wall ms, 0 = alive
}

export interface SwarmGenStats {
  gen: number;
  best: number;
  mean: number;
  species: number;
  bestFrames: number;
}

export class Swarm {
  readonly pop: Population;
  ghosts: Ghost[] = [];
  history: SwarmGenStats[] = [];
  selected: Ghost | null = null;
  onGeneration: (s: SwarmGenStats, best: Genome) => void = () => {};
  onBestCrash: (info: {gen: number; frames: number; obstacles: string}) => void = () => {};
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sprite: HTMLImageElement;
  private readonly loop: FixedLoop;
  private readonly tabSeed: number;
  private frame = 0;

  constructor(canvas: HTMLCanvasElement, sprite: HTMLImageElement, tabSeed: number) {
    this.ctx = canvas.getContext('2d')!;
    this.sprite = sprite;
    this.tabSeed = tabSeed;
    this.pop = Population.create(tabSeed, {...DEFAULT_NEAT, populationSize: 150});
    this.loop = new FixedLoop(() => this.step(), () => this.render(), 2000);
    canvas.addEventListener('click', (e) => this.pick(canvas, e));
  }

  set speed(x: number) {
    this.loop.speed = x;
  }

  start(): void {
    this.spawn();
    this.loop.start();
  }

  get generation(): number {
    return this.pop.generation;
  }

  get alive(): number {
    return this.ghosts.filter((g) => !g.diedAt).length;
  }

  private spawn(): void {
    const seed = (Math.imul(this.tabSeed ^ 0x5bd1e995, this.pop.generation + 1) >>> 0) || 1;
    this.frame = 0;
    const prevSelected = this.selected?.memberIndex;
    this.ghosts = this.pop.members.map((m, i) => ({
      game: Game.create(engine, seed),
      policy: new BrainPolicy(new Network(m.genome)),
      memberIndex: i,
      species: m.species,
      diedAt: 0,
    }));
    this.selected = prevSelected !== undefined ? null : null;
  }

  private step(): boolean {
    this.frame++;
    let anyAlive = false;
    for (const gh of this.ghosts) {
      if (gh.diedAt) continue;
      if (!gh.game.step(gh.policy.keys(gh.game.runner))) {
        gh.diedAt = performance.now();
      } else {
        anyAlive = true;
      }
    }
    if (!anyAlive || this.frame >= GEN_CAP_FRAMES) {
      this.endGeneration();
    }
    return true;
  }

  private endGeneration(): void {
    const frames = this.ghosts.map((g) => g.game.frame);
    const fitness = frames.map((f) => f / GEN_CAP_FRAMES);
    const bestIdx = frames.indexOf(Math.max(...frames));
    const best = this.ghosts[bestIdx]!;
    const stats: SwarmGenStats = {
      gen: this.pop.generation,
      best: Math.max(...fitness),
      mean: fitness.reduce((a, b) => a + b, 0) / fitness.length,
      species: this.pop.species.length,
      bestFrames: frames[bestIdx]!,
    };
    this.history.push(stats);
    if (best.game.crashed) {
      const r = best.game.runner;
      this.onBestCrash({gen: stats.gen, frames: best.game.frame,
        obstacles: r.horizon.obstacles.slice(0, 2).map((o: any) => `${o.typeConfig.type}${o.size}@${o.yPos}`).join(' ')});
    }
    const bestGenome = this.pop.members[bestIdx]!.genome;
    this.pop.advance(fitness);
    this.onGeneration(stats, bestGenome);
    this.spawn();
  }

  private render(): void {
    const ctx = this.ctx;
    const lead = this.ghosts.find((g) => !g.diedAt) ?? this.ghosts[0];
    if (!lead) return;
    drawWorld(lead.game, ctx, this.sprite);
    const now = performance.now();
    // Ghosts in the same pose draw once; opacity grows with how many share
    // it, so a crowd reads as a crowd instead of a solid blob.
    const poses = new Map<string, {gh: Ghost; count: number; fade: number}>();
    for (const gh of this.ghosts) {
      if (gh === this.selected) continue;
      const fade = gh.diedAt ? Math.max(0, 1 - (now - gh.diedAt) / 700) : 1;
      if (fade <= 0) continue;
      const t = gh.game.runner.tRex;
      const key = `${gh.species}|${Math.round(t.yPos)}|${t.status}|${t.currentFrame}|${t.ducking}|${gh.diedAt ? gh.memberIndex : ''}`;
      const p = poses.get(key);
      if (p) p.count++;
      else poses.set(key, {gh, count: 1, fade});
    }
    for (const {gh, count, fade} of poses.values()) {
      const color = SPECIES_COLORS[gh.species % SPECIES_COLORS.length]!;
      const alpha = gh.diedAt ? 0.35 : 0.16 + 0.5 * Math.min(1, count / 40);
      drawTrex(gh.game, ctx, tintedSprite(this.sprite, color), alpha * fade);
    }
    if (this.selected && !this.selected.diedAt) {
      drawTrex(this.selected.game, ctx, this.sprite, 1);
    }
  }

  private pick(canvas: HTMLCanvasElement, e: MouseEvent): void {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 600;
    const y = ((e.clientY - rect.top) / rect.height) * 150;
    let best: Ghost | null = null;
    let bestD = 40;
    for (const gh of this.ghosts) {
      if (gh.diedAt) continue;
      const t = gh.game.runner.tRex;
      const d = Math.hypot(t.xPos + 22 - x, t.yPos + 23 - y);
      if (d < bestD) {
        bestD = d;
        best = gh;
      }
    }
    this.selected = best ?? this.ghosts.find((g) => !g.diedAt) ?? null;
  }

  /** The ghost whose brain is shown: the clicked one, else the longest-lived. */
  focus(): Ghost | null {
    if (this.selected && !this.selected.diedAt) return this.selected;
    return this.ghosts.find((g) => !g.diedAt) ?? null;
  }

  label(): string {
    return `generation ${formatInt(this.pop.generation)} · ${this.alive}/${this.ghosts.length} alive · ${this.pop.species.length} species`;
  }

  leadScore(): number {
    const lead = this.ghosts.find((g) => !g.diedAt);
    return lead ? scoreOf(lead.game) : 0;
  }
}
