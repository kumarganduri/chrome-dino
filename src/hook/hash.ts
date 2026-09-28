// FNV-1a 32-bit over strings and exact float64 bit patterns. Identical input
// gives identical output in every JS engine.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

export class Hasher {
  h = 0x811c9dc5;

  int(n: number): this {
    let h = this.h;
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 24) & 0xff;
    this.h = Math.imul(h, 0x01000193);
    return this;
  }

  num(n: number): this {
    f64[0] = n;
    return this.int(u32[0]!).int(u32[1]!);
  }

  bool(b: boolean): this {
    return this.int(b ? 1 : 0);
  }

  str(s: string): this {
    for (let i = 0; i < s.length; i++) {
      this.int(s.charCodeAt(i));
    }
    return this;
  }

  digest(): number {
    return this.h >>> 0;
  }
}

export function hashString(s: string): number {
  return new Hasher().str(s).digest();
}
