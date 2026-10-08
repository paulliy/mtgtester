/**
 * Seeded PRNG for the engine (brief §5.9). One instance per game governs ALL randomness:
 * shuffles, starting-player determination, coin flips, die rolls, "choose at random".
 * `Math.random()` is never used anywhere in this package.
 *
 * Algorithm: xoshiro128** (Blackman/Vigna) — small, fast, well-tested, and defined
 * entirely in terms of 32-bit integer ops, so results are identical on every JS runtime.
 * The 128-bit state is seeded from the game's seed string via splitmix32.
 */

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/** FNV-1a 32-bit hash of the seed string, used to key splitmix32. */
function hashSeedString(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Prng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: string) {
    const mix = splitmix32(hashSeedString(seed));
    this.s0 = mix();
    this.s1 = mix();
    this.s2 = mix();
    this.s3 = mix();
    // All-zero state is invalid for xoshiro; splitmix output makes this astronomically
    // unlikely, but guard anyway.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s3 = 1;
  }

  /** An independent stream at the current position, rather than a reseeded stream. */
  clone(): Prng {
    const copy = new Prng('cloned-stream');
    copy.s0 = this.s0;
    copy.s1 = this.s1;
    copy.s2 = this.s2;
    copy.s3 = this.s3;
    return copy;
  }

  /** Next raw 32-bit unsigned integer. */
  nextUint32(): number {
    const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /**
   * Uniform integer in `[0, bound)` via rejection sampling (no modulo bias).
   * `bound` must be a positive integer ≤ 2^32.
   */
  nextInt(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0 || bound > 0x100000000) {
      throw new RangeError(`Prng.nextInt bound must be an integer in [1, 2^32], got ${bound}`);
    }
    const limit = Math.floor(0x100000000 / bound) * bound;
    let x = this.nextUint32();
    while (x >= limit) x = this.nextUint32();
    return x % bound;
  }

  /** In-place Fisher–Yates shuffle. Used for library shuffles and mulligan reshuffles. */
  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const a = items[i] as T;
      items[i] = items[j] as T;
      items[j] = a;
    }
  }
}
