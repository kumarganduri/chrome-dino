// Seeded PRNG (mulberry32) that stands in for Math.random while a game steps.
// 32-bit integer math only, so every JS engine produces identical sequences.
export class Rng {
  state: number;
  calls = 0;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next = (): number => {
    this.calls++;
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
