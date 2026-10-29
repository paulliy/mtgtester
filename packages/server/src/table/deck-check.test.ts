import { describe, it, expect, vi } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { TABLE_MAX_DECKLIST_CHARS } from '@mtg/shared';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { parseBannedList } from '../decks/banned';
import { fillerCreatures, makeOracleCard } from '../test-factory';
import { createDeckChecker, TABLE_MAX_DECKLIST_LINES } from './deck-check';

const commander = makeOracleCard({
  name: 'Azusa, Lost but Seeking',
  typeLine: 'Legendary Creature — Human Monk',
  supertypes: ['Legendary'],
  types: ['Creature'],
  colorIdentity: ['G'],
  cmc: 3,
});
const fillers: OracleCard[] = fillerCreatures(99, ['G']).map((entry) => entry.card);
const index = buildOracleIndexFromCards([commander, ...fillers]);
const check = createDeckChecker({ index, banned: parseBannedList('') });

const decklist = (count = 99): string =>
  [
    'Commander',
    commander.name,
    '',
    'Deck',
    ...fillers.slice(0, count).map((c) => `1 ${c.name}`),
  ].join('\n');

describe('createDeckChecker', () => {
  it('accepts a legal plaintext decklist and returns the resolved deck', () => {
    const result = check(decklist());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deck.commanders.map((c) => c.name)).toEqual([commander.name]);
      expect(result.deck.sourceType).toBe('plaintext');
      expect(result.deck.sourceUrl).toBeNull();
    }
  });

  it('reports every validation problem', () => {
    const result = check(decklist(90));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((p) => p.code)).toContain('cardCount');
  });

  it('names cards that do not resolve', () => {
    const result = check(`${decklist(98)}\n1 Not A Real Card`);
    expect(result).toEqual({
      ok: false,
      problems: [
        {
          code: 'unresolved',
          message: expect.stringContaining('Not A Real Card') as string,
          cardName: 'Not A Real Card',
        },
      ],
    });
  });

  it('treats a URL as a card name and never fetches it', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = check('https://www.moxfield.com/decks/abc123');
      expect(result.ok).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses an oversized decklist before parsing it', () => {
    const tooLong = check('x'.repeat(TABLE_MAX_DECKLIST_CHARS + 1));
    expect(tooLong).toMatchObject({ ok: false, problems: [{ code: 'tooLarge' }] });
    const tooManyLines = check('1 Forest\n'.repeat(TABLE_MAX_DECKLIST_LINES + 1));
    expect(tooManyLines).toMatchObject({ ok: false, problems: [{ code: 'tooLarge' }] });
  });
});
