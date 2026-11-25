import { describe, expect, it } from 'vitest';
import { validateBatch, MAX_BATCH_GAMES } from './manager';

const seats = Array.from({ length: 4 }, () => ({ kind: 'pool' as const }));

describe('batch validation', () => {
  it('accepts a four-seat scenario and preserves deterministic seed input', () => {
    const result = validateBatch({
      seed: 'fixed',
      scenarios: [{ id: 'pod', name: 'Pod', seats, providerKind: 'random', games: 2 }],
    });
    expect(result).toEqual({
      ok: true,
      spec: {
        seed: 'fixed',
        scenarios: [{ id: 'pod', name: 'Pod', seats, providerKind: 'random', games: 2 }],
      },
    });
  });
  it('rejects duplicate scenario ids and over-limit batches', () => {
    expect(
      validateBatch({
        scenarios: [
          { id: 'x', name: 'X', seats, providerKind: 'random', games: 1 },
          { id: 'x', name: 'Y', seats, providerKind: 'random', games: 1 },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateBatch({
        scenarios: [
          { id: 'x', name: 'X', seats, providerKind: 'random', games: MAX_BATCH_GAMES + 1 },
        ],
      }).ok,
    ).toBe(false);
  });
  it('trims the optional run name, drops a blank one, and rejects a long or non-string one', () => {
    const scenarios = [{ id: 'pod', name: 'Pod', seats, providerKind: 'random', games: 1 }];
    const named = validateBatch({ name: '  Ur-Dragon seat test  ', scenarios });
    expect(named.ok && named.spec.name).toBe('Ur-Dragon seat test');
    const blank = validateBatch({ name: '   ', scenarios });
    expect(blank.ok && 'name' in blank.spec).toBe(false);
    expect(validateBatch({ name: 'x'.repeat(80), scenarios }).ok).toBe(true);
    expect(validateBatch({ name: 'x'.repeat(81), scenarios }).ok).toBe(false);
    expect(validateBatch({ name: 7, scenarios }).ok).toBe(false);
  });
  it('rejects malformed seat lists', () => {
    expect(
      validateBatch({
        scenarios: [{ id: 'x', name: 'X', seats: [], providerKind: 'random', games: 1 }],
      }).ok,
    ).toBe(false);
  });
});

import { deriveBatchGameSeed } from './manager';

describe('batch seed derivation', () => {
  it('is stable and unique by scenario/game position', () => {
    expect(deriveBatchGameSeed('batch', 0, 0)).toBe('batch:s1:g1');
    expect(deriveBatchGameSeed('batch', 0, 0)).not.toBe(deriveBatchGameSeed('batch', 0, 1));
    expect(deriveBatchGameSeed('batch', 0, 1)).not.toBe(deriveBatchGameSeed('batch', 1, 0));
  });
});
