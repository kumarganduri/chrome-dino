// No-op 2D context and canvas for headless steps and fast-forward. Covers
// every member the vendored game touches (see `grep canvasCtx.` in vendor/).
export class NullContext2D {
  globalAlpha = 1;
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  drawImage(): void {}
  save(): void {}
  restore(): void {}
  translate(): void {}
  scale(): void {}
  strokeRect(): void {}
  fill(): void {}
  clearRect(): void {}
  rect(): void {}
  fillRect(): void {}
  setTransform(): void {}
  beginPath(): void {}
}

export function createNullCanvas(width: number, height: number) {
  const ctx = new NullContext2D();
  return {
    width,
    height,
    style: {} as Record<string, string>,
    className: '',
    getContext: () => ctx,
    addEventListener(): void {},
    getBoundingClientRect: () => ({top: 0, left: 0, width, height}),
  };
}

export function createNullImage() {
  return {complete: true, width: 0, height: 0, addEventListener(): void {}};
}
