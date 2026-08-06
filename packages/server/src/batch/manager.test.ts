import { describe, expect, it } from 'vitest';
import { validateBatch, MAX_BATCH_GAMES } from './manager';

const seats = Array.from({ length: 4 }, () => ({ kind: 'pool' as const }));

describe('batch validation', () => {
  it('accepts a four-seat scenario and preserves deterministic seed input', () => {
    const result = validateBatch({ seed: 'fixed', scenarios: [{ id: 'pod', name: 'Pod', seats, providerKind: 'random', games: 2 }] });
    expect(result).toEqual({ ok: true, spec: { seed: 'fixed', scenarios: [{ id: 'pod', name: 'Pod', seats, providerKind: 'random', games: 2 }] } });
  });
  it('rejects duplicate scenario ids and over-limit batches', () => {
    expect(validateBatch({ scenarios: [{ id: 'x', name: 'X', seats, providerKind: 'random', games: 1 }, { id: 'x', name: 'Y', seats, providerKind: 'random', games: 1 }] }).ok).toBe(false);
    expect(validateBatch({ scenarios: [{ id: 'x', name: 'X', seats, providerKind: 'random', games: MAX_BATCH_GAMES + 1 }] }).ok).toBe(false);
  });
  it('rejects malformed seat lists', () => {
    expect(validateBatch({ scenarios: [{ id: 'x', name: 'X', seats: [], providerKind: 'random', games: 1 }] }).ok).toBe(false);
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
