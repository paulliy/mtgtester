/**
 * A small self-contained seeded PRNG (mulberry32). `@mtg/bot` deliberately depends only on
 * `@mtg/shared` (ADR 0023 item 1), so it cannot reuse the engine's own `Prng`
 * (`packages/engine/src/rng/prng.ts`) — this is a separate, independent generator for breaking
 * ties between equally-scored actions (ADR item 11). It is not the game's RNG: like
 * `RandomDecisionProvider`, this generator belongs to the *player*, not the engine, and never
 * touches rules state directly. `Math.random()` is never used (brief §4, §5.9).
 */
export class Rng {
  private state: number;

  constructor(seed: string) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    this.state = h >>> 0;
  }

  private next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A deterministic integer in `[0, maxExclusive)`. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }
}
