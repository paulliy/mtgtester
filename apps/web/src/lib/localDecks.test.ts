import { describe, expect, it } from 'vitest';
import {
  exportLocalDecks,
  LOCAL_DECKS_KEY,
  LOCAL_DECKS_LIMIT,
  localDeckId,
  readLocalDecks,
  removeLocalDeck,
  saveLocalDeck,
  touchLocalDeck,
} from './localDecks';

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

const LIST = '1 Breena, the Demagogue\n99 Plains';
const deck = (text: string, commander = 'Breena, the Demagogue') => ({
  text,
  commanderNames: [commander],
  colorIdentity: ['W', 'B'],
  archetypeTag: '',
});

describe('local saved decks', () => {
  it('keys a list by its text, ignoring line endings and edge spaces', () => {
    expect(localDeckId('1 Breena, the Demagogue\r\n99 Plains  \n')).toBe(localDeckId(LIST));
    expect(localDeckId(LIST)).not.toBe(localDeckId('1 Breena, the Demagogue\n98 Plains'));
  });

  it('saves a list once, newest first, and freshens a repeat', () => {
    const storage = memoryStorage();
    const first = saveLocalDeck(deck(LIST), new Date('2026-11-01T00:00:00Z'), storage);
    saveLocalDeck(
      deck('1 Other Commander\n99 Swamp', 'Other Commander'),
      new Date('2026-11-02T00:00:00Z'),
      storage,
    );
    expect(readLocalDecks(storage).map((d) => d.name)).toEqual([
      'Other Commander',
      'Breena, the Demagogue',
    ]);
    expect(saveLocalDeck(deck(`${LIST}\n`), new Date('2026-11-03T00:00:00Z'), storage)).toBe(first);
    expect(readLocalDecks(storage).map((d) => d.snapshotId)).toEqual([
      first,
      localDeckId('1 Other Commander\n99 Swamp'),
    ]);
  });

  it('moves a played deck to the top and forgets a removed one', () => {
    const storage = memoryStorage();
    const a = saveLocalDeck(deck(LIST), new Date('2026-11-01T00:00:00Z'), storage);
    const b = saveLocalDeck(deck('1 B\n99 Swamp', 'B'), new Date('2026-11-02T00:00:00Z'), storage);
    touchLocalDeck(a, new Date('2026-11-03T00:00:00Z'), storage);
    expect(readLocalDecks(storage)[0]?.snapshotId).toBe(a);
    removeLocalDeck(a, storage);
    expect(readLocalDecks(storage).map((d) => d.snapshotId)).toEqual([b]);
  });

  it('keeps at most the limit, dropping the oldest', () => {
    const storage = memoryStorage();
    for (let i = 0; i <= LOCAL_DECKS_LIMIT; i += 1) {
      saveLocalDeck(
        deck(`1 C${i}\n99 Plains`, `C${i}`),
        new Date(Date.UTC(2026, 0, 1, 0, i)),
        storage,
      );
    }
    const kept = readLocalDecks(storage);
    expect(kept).toHaveLength(LOCAL_DECKS_LIMIT);
    expect(kept.some((d) => d.name === 'C0')).toBe(false);
  });

  it('reads damaged storage as empty and skips malformed entries', () => {
    const storage = memoryStorage();
    storage.setItem(LOCAL_DECKS_KEY, '{not json');
    expect(readLocalDecks(storage)).toEqual([]);
    storage.setItem(LOCAL_DECKS_KEY, JSON.stringify([{ snapshotId: 'x' }]));
    expect(readLocalDecks(storage)).toEqual([]);
  });

  it('exports every list under a line naming it', () => {
    const storage = memoryStorage();
    saveLocalDeck({ ...deck(LIST), archetypeTag: 'control' }, new Date(), storage);
    expect(exportLocalDecks(readLocalDecks(storage))).toBe(
      `// Breena, the Demagogue (control)\n${LIST}\n`,
    );
  });
});
