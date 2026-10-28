/**
 * The engine's random source (brief §5.9, ADR 0031 decision 4). `Prng` keeps every fixed-seed
 * game, benchmark and stored replay as it is; `ChaCha20Rng` is the keyed stream table games use.
 * `clone()` returns an independent stream at the current position.
 */
export interface EngineRng {
  nextUint32(): number;
  nextInt(bound: number): number;
  shuffle<T>(items: T[]): void;
  clone(): EngineRng;
}

/**
 * Uniform integer in `[0, bound)` via rejection sampling (no modulo bias). `bound` must be a
 * positive integer ≤ 2^32.
 */
export function nextIntFrom(
  rng: Pick<EngineRng, 'nextUint32'>,
  bound: number,
  name: string,
): number {
  if (!Number.isInteger(bound) || bound <= 0 || bound > 0x100000000) {
    throw new RangeError(`${name}.nextInt bound must be an integer in [1, 2^32], got ${bound}`);
  }
  const limit = Math.floor(0x100000000 / bound) * bound;
  let x = rng.nextUint32();
  while (x >= limit) x = rng.nextUint32();
  return x % bound;
}

/** In-place Fisher–Yates shuffle. Used for library shuffles and mulligan reshuffles. */
export function shuffleWith<T>(rng: Pick<EngineRng, 'nextInt'>, items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
}
