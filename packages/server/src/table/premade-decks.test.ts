import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { loadBannedList } from '../decks/banned-file';
import { createDeckChecker } from './deck-check';
import { loadPremadeDecks, nameFromSlug } from './premade-decks';

const cards = JSON.parse(
  readFileSync(resolve('packages/server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const index = buildOracleIndexFromCards(cards);
const banned = loadBannedList(resolve('docs/rules/commander-banned-list.md'));

describe('premade table decks', () => {
  it('lists the modeled coverage decks, each one a list the seat check accepts', async () => {
    const decks = await loadPremadeDecks(index, banned);
    expect(decks.length).toBeGreaterThanOrEqual(5);
    const check = createDeckChecker({ index, banned });
    for (const deck of decks) {
      expect(check(deck.text).ok, deck.slug).toBe(true);
      expect(deck.commanderNames.length).toBeGreaterThan(0);
      expect(deck.name).not.toBe('');
    }
    const names = decks.map((deck) => deck.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(decks.map((deck) => deck.slug)).size).toBe(decks.length);
  });

  it('is empty, not an error, when the deck folder is missing', async () => {
    const decks = await loadPremadeDecks(index, banned, 'packages/server/fixtures/no-such-folder');
    expect(decks).toEqual([]);
  });
});

describe('premade deck names', () => {
  it('reads a file name as a title when the list names no deck', () => {
    expect(nameFromSlug('queen-marchesa-queens-gambit')).toBe('Queen Marchesa Queens Gambit');
    expect(nameFromSlug('ruby-the-most-daring-of-trackers')).toBe(
      'Ruby the Most Daring of Trackers',
    );
    expect(nameFromSlug('the-fantastic-four-marvel-super-heroes-commander-precon-decklist')).toBe(
      'The Fantastic Four Marvel Super Heroes',
    );
  });
});
