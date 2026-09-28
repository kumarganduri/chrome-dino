// Training chart: best and mean fitness per generation (plus gate markers),
// drawn on a DPR-aware canvas. Fitness 1.0 = survived every training run to
// the cap (10 min at top speed).
export interface ChartRow {
  gen: number;
  best: number;
  mean: number;
  gateTried?: boolean;
  champion?: number | null;
}

export class FitnessChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private rows: ChartRow[] = [];
  private hover: number | null = null;
  private readonly tip: HTMLElement;

  constructor(canvas: HTMLCanvasElement, tip: HTMLElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.tip = tip;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = (e.clientX - r.left) / r.width;
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.tip.hidden = true;
      this.draw();
    });
  }

  set(rows: ChartRow[]): void {
    this.rows = rows;
    this.draw();
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    const css = getComputedStyle(this.canvas);
    const ink = css.getPropertyValue('--ink').trim();
    const muted = css.getPropertyValue('--muted').trim();
    const line = css.getPropertyValue('--line').trim();
    const accent = css.getPropertyValue('--pos').trim();
    const good = css.getPropertyValue('--good').trim();
    ctx.clearRect(0, 0, w, h);
    const padL = 34;
    const padB = 18;
    const plotW = w - padL - 8;
    const plotH = h - padB - 8;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = muted;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const y = 8 + plotH * (1 - v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.toFixed(2), padL - 6, y);
    }
    const rows = this.rows;
    if (rows.length < 2) return;
    const x = (i: number) => padL + (plotW * i) / (rows.length - 1);
    const y = (v: number) => 8 + plotH * (1 - Math.max(0, Math.min(1, v)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`gen ${rows[0]!.gen}`, padL + 18, h - padB + 4);
    ctx.fillText(`gen ${rows.at(-1)!.gen}`, padL + plotW - 24, h - padB + 4);
    const path = (key: 'best' | 'mean', color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      rows.forEach((r, i) => (i ? ctx.lineTo(x(i), y(r[key])) : ctx.moveTo(x(i), y(r[key]))));
      ctx.stroke();
    };
    path('mean', muted, 1);
    path('best', ink, 1.6);
    // Champion promotions.
    rows.forEach((r, i) => {
      if (i > 0 && r.champion && r.champion !== rows[i - 1]!.champion) {
        ctx.strokeStyle = good;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x(i), 8);
        ctx.lineTo(x(i), 8 + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = good;
        ctx.textAlign = 'left';
        ctx.fillText(`★ v${r.champion}`, x(i) + 4, 10);
      }
    });
    if (this.hover !== null) {
      const i = Math.max(0, Math.min(rows.length - 1, Math.round(((this.hover * w - padL) / plotW) * (rows.length - 1))));
      const r = rows[i]!;
      ctx.strokeStyle = accent;
      ctx.beginPath();
      ctx.moveTo(x(i), 8);
      ctx.lineTo(x(i), 8 + plotH);
      ctx.stroke();
      this.tip.hidden = false;
      this.tip.textContent = `gen ${r.gen} · best ${r.best.toFixed(3)} · mean ${r.mean.toFixed(3)}${r.gateTried ? ' · gate tried' : ''}`;
    }
  }
}
