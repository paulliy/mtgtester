import { afterEach, describe, expect, it, vi } from 'vitest';
import { pruneRecentIds, pushRecentId, syncRecentDeckIds } from './recentSetup';

/** Mirrors the store tests' stub, plus a write log so "did not touch storage" is assertable. */
function stubStorage(seed: Record<string, string>): {
  values: Map<string, string>;
  writes: string[];
} {
  const values = new Map(Object.entries(seed));
  const writes: string[] = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  });
  return { values, writes };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser local setup recents', () => {
  it('keeps stable IDs, removes missing entries and bounds history', () => {
    expect(pruneRecentIds(['gone', 'a', 'a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
    expect(pushRecentId(['a', 'b', 'c', 'd', 'e'], 'b')).toEqual(['b', 'a', 'c', 'd', 'e']);
    expect(pushRecentId(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
  });
});

describe('recent deck IDs against a no-database server', () => {
  const key = 'mtg-recent-deck-ids';

  it('preserves stored deck IDs when saved decks are disabled', () => {
    const stored = JSON.stringify(['snapshot-a', 'snapshot-b']);
    const storage = stubStorage({ [key]: stored });

    // A no-DB server answers `{ enabled: false, decks: [] }`. Empty means "cannot say", not
    // "none exist", so the user's saved-deck history must survive the visit intact.
    const kept = syncRecentDeckIds(key, ['snapshot-a', 'snapshot-b'], {
      enabled: false,
      available: [],
    });

    expect(kept).toEqual(['snapshot-a', 'snapshot-b']);
    expect(storage.writes).toEqual([]);
    expect(storage.values.get(key)).toBe(stored);
  });

  it('prunes and persists against the decks a database-backed server offers', () => {
    const storage = stubStorage({ [key]: JSON.stringify(['removed', 'snapshot-b']) });

    const kept = syncRecentDeckIds(key, ['removed', 'snapshot-b'], {
      enabled: true,
      available: ['snapshot-b'],
    });

    expect(kept).toEqual(['snapshot-b']);
    expect(storage.writes).toEqual([key]);
    expect(storage.values.get(key)).toBe(JSON.stringify(['snapshot-b']));
  });
});
