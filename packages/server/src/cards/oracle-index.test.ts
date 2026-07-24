import { describe, it, expect } from 'vitest';
import { buildOracleIndex } from './oracle-index';
import type { RawScryfallCard } from './scryfall';
import { strictKey, looseKey } from './normalize';

const raw = (
  over: Partial<RawScryfallCard> & { name: string; oracle_id: string },
): RawScryfallCard => ({
  id: over.oracle_id,
  type_line: 'Creature — Human',
  legalities: { commander: 'legal' },
  ...over,
});

describe('name normalization', () => {
  it('collapses curly apostrophes and case in the strict key', () => {
    expect(strictKey('Yawgmoth’s Bargain')).toBe(strictKey("yawgmoth's bargain"));
  });
  it('strips diacritics and DFC back-halves in the loose key', () => {
    expect(looseKey('Nazgûl')).toBe('nazgul');
    expect(looseKey('Fire // Ice')).toBe('fire');
  });
});

describe('buildOracleIndex.resolve', () => {
  const index = buildOracleIndex([
    raw({ name: "Yawgmoth's Bargain", oracle_id: 'y1' }),
    raw({ name: 'Nazgûl', oracle_id: 'n1' }),
    raw({ name: 'Fire // Ice', oracle_id: 'fi', type_line: 'Instant // Instant' }),
    // Two distinct names that collapse to the same loose key ("cool card").
    raw({ name: 'Cool Card', oracle_id: 'c1' }),
    raw({ name: 'Cool Card!', oracle_id: 'c2' }),
  ]);

  it('resolves an exact name regardless of apostrophe style', () => {
    expect(index.resolve('Yawgmoth’s Bargain')?.oracleId).toBe('y1');
    expect(index.resolve("YAWGMOTH'S BARGAIN")?.oracleId).toBe('y1');
  });

  it('resolves a missing-diacritic name via the loose key', () => {
    expect(index.resolve('Nazgul')?.oracleId).toBe('n1');
  });

  it('resolves a double-faced card by its front-face name', () => {
    expect(index.resolve('Fire')?.oracleId).toBe('fi');
    expect(index.resolve('Fire // Ice')?.oracleId).toBe('fi');
  });

  it('returns null for an unknown name rather than guessing', () => {
    expect(index.resolve('Definitely Not A Card')).toBeNull();
  });

  it('still resolves an exact name that shares a loose key with another card', () => {
    expect(index.resolve('Cool Card')?.oracleId).toBe('c1');
    expect(index.resolve('Cool Card!')?.oracleId).toBe('c2');
  });

  it('refuses to guess when only an ambiguous loose key matches', () => {
    // "cool card??" has no strict match; its loose key is shared by two cards → unresolved.
    expect(index.resolve('cool card??')).toBeNull();
  });
});
