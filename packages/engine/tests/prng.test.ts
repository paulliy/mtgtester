import { describe, expect, it } from 'vitest';
import { Prng } from '../src/rng/prng';

describe('seeded PRNG (brief §5.9)', () => {
  it('is deterministic for the same seed', () => {
    const a = new Prng('seed-1');
    const b = new Prng('seed-1');
    for (let i = 0; i < 1000; i++) {
      expect(a.nextUint32()).toBe(b.nextUint32());
    }
  });

  it('differs across seeds', () => {
    const a = new Prng('seed-1');
    const b = new Prng('seed-2');
    const runA = Array.from({ length: 16 }, () => a.nextUint32());
    const runB = Array.from({ length: 16 }, () => b.nextUint32());
    expect(runA).not.toEqual(runB);
  });

  it('nextInt stays in bounds and hits every value', () => {
    const rng = new Prng('bounds');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = rng.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it('nextInt rejects invalid bounds', () => {
    const rng = new Prng('x');
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(-1)).toThrow(RangeError);
    expect(() => rng.nextInt(1.5)).toThrow(RangeError);
  });

  it('shuffle is a deterministic permutation', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = [...a];
    new Prng('shuffle-seed').shuffle(a);
    new Prng('shuffle-seed').shuffle(b);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
