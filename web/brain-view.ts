// Live brain: a NEAT network drawn with its current activations.
//
//   inputs (left)  →  hidden nodes (columns by depth)  →  JUMP / DUCK (right)
//   edge color: blue = positive weight, orange = negative; width ∝ |w|;
//   opacity ∝ the signal it carries right now (|activation × w|).
//   node fill: its activation (0 → paper, 1 → ink); an output above 0.5 is a
//   held key and glows.
import type {Genome} from '../src/neat/genome.ts';
import {INPUTS, OUTPUTS, type Network} from '../src/web/core.ts';

const INPUT_LABELS = [
  'obs 1 distance', 'obs 1 time-to-hit', 'obs 1 width', 'obs 1 height', 'obs 1 small cactus', 'obs 1 large cactus', 'obs 1 pterodactyl', 'obs 1 gap',
  'obs 2 distance', 'obs 2 time-to-hit', 'obs 2 width', 'obs 2 height', 'obs 2 small cactus', 'obs 2 large cactus', 'obs 2 pterodactyl', 'obs 2 gap',
  'dino height', 'dino velocity', 'ducking', 'speed', 'bias',
];
const OUTPUT_LABELS = ['JUMP', 'DUCK'];

interface Layout {
  pos: Map<number, {x: number; y: number}>;
  width: number;
  height: number;
}

export class BrainView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private genome: Genome | null = null;
  private net: Network | null = null;
  private layout: Layout | null = null;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  show(genome: Genome, net: Network): void {
    if (genome !== this.genome) {
      this.genome = genome;
      this.layout = null;
    }
    this.net = net;
  }

  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.layout = null;
  }

  private computeLayout(g: Genome): Layout {
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    const depth = new Map<number, number>();
    for (const n of g.nodes) depth.set(n.id, n.kind === 'input' ? 0 : 1);
    // Longest-path depth (graph is acyclic; relax |nodes| times).
    for (let pass = 0; pass < g.nodes.length; pass++) {
      let changed = false;
      for (const c of g.conns) {
        if (!c.on) continue;
        const d = depth.get(c.from)! + 1;
        if (d > depth.get(c.to)!) {
          depth.set(c.to, d);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const maxHidden = Math.max(1, ...g.nodes.filter((n) => n.kind === 'hidden').map((n) => depth.get(n.id)!));
    const left = 118;
    const right = width - 56;
    const pos = new Map<number, {x: number; y: number}>();
    const top = 10;
    const usable = height - 20;
    for (let i = 0; i < INPUTS; i++) pos.set(i, {x: left, y: top + (usable * (i + 0.5)) / INPUTS});
    for (let o = 0; o < OUTPUTS; o++) pos.set(INPUTS + o, {x: right, y: top + (usable * (o + 1)) / (OUTPUTS + 1)});
    const columns = new Map<number, number[]>();
    for (const n of g.nodes) {
      if (n.kind !== 'hidden') continue;
      const d = depth.get(n.id)!;
      if (!columns.has(d)) columns.set(d, []);
      columns.get(d)!.push(n.id);
    }
    for (const [d, ids] of columns) {
      const x = left + ((right - left) * d) / (maxHidden + 1);
      ids.forEach((id, k) => pos.set(id, {x, y: top + (usable * (k + 0.5)) / ids.length}));
    }
    return {pos, width, height};
  }

  render(): void {
    const g = this.genome;
    const net = this.net;
    if (!g || !net || this.canvas.width === 0) return;
    this.layout ??= this.computeLayout(g);
    const {pos, width, height} = this.layout;
    const ctx = this.ctx;
    const css = getComputedStyle(this.canvas);
    const ink = css.getPropertyValue('--ink').trim() || '#202124';
    const paper = css.getPropertyValue('--card').trim() || '#fff';
    const muted = css.getPropertyValue('--muted').trim() || '#70757a';
    const pos_ = css.getPropertyValue('--pos').trim() || '#1a73e8';
    const neg = css.getPropertyValue('--neg').trim() || '#e8710a';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    for (const c of g.conns) {
      if (!c.on) continue;
      const a = pos.get(c.from)!;
      const b = pos.get(c.to)!;
      const signal = Math.min(1, Math.abs(net.valueOf(c.from) * c.w) / 3);
      ctx.strokeStyle = c.w >= 0 ? pos_ : neg;
      ctx.globalAlpha = 0.08 + 0.8 * signal;
      ctx.lineWidth = 0.5 + Math.min(3, Math.abs(c.w) / 4);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      const mx = (a.x + b.x) / 2;
      ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const n of g.nodes) {
      const p = pos.get(n.id)!;
      const v = net.valueOf(n.id);
      const out = n.kind === 'output';
      const r = out ? 9 : n.kind === 'hidden' ? 5 : 3.5;
      const on = out && v > 0.5;
      if (on) {
        ctx.fillStyle = pos_;
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = on ? pos_ : mix(paper, ink, Math.max(0, Math.min(1, n.kind === 'input' ? Math.abs(v) : v)));
      ctx.strokeStyle = on ? pos_ : muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (n.kind === 'input') {
        ctx.fillStyle = muted;
        ctx.textAlign = 'right';
        ctx.fillText(INPUT_LABELS[n.id] ?? `in ${n.id}`, p.x - 8, p.y);
      } else if (out) {
        ctx.fillStyle = on ? pos_ : muted;
        ctx.textAlign = 'left';
        ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(OUTPUT_LABELS[n.id - INPUTS]!, p.x + 14, p.y);
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      }
    }
  }

  describe(): string {
    const g = this.genome;
    if (!g) return '';
    const hidden = g.nodes.filter((n) => n.kind === 'hidden').length;
    return `${hidden} hidden neuron${hidden === 1 ? '' : 's'} · ${g.conns.filter((c) => c.on).length} connections`;
  }
}

function mix(a: string, b: string, t: number): string {
  const pa = parse(a);
  const pb = parse(b);
  const c = pa.map((x, i) => Math.round(x + (pb[i]! - x) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function parse(color: string): number[] {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16));
  const rgb = color.match(/\d+/g);
  return rgb ? rgb.slice(0, 3).map(Number) : [0, 0, 0];
}
