/**
 * Premade decks for table seats: the modeled coverage decks single player already offers
 * (`cards/known-decks.ts`), so a player can take a seat without pasting a list. Built once when
 * the table server starts and served from memory by `GET /tables/decks`.
 *
 * A deck is listed only when the table's own claim check accepts its text, so picking one can
 * never produce deck problems the player did not cause.
 */

import type { TablePremadeDeck } from '@mtg/shared';
import { listKnownDecks } from '../cards/known-decks';
import type { OracleIndex } from '../cards/oracle-index';
import type { BannedList } from '../decks/banned';
import { createDeckChecker } from './deck-check';

const SMALL_WORDS = new Set(['a', 'an', 'and', 'of', 'the', 'to', 'in', 'on']);

/** `the-fantastic-four-marvel-super-heroes-commander-precon-decklist` -> `The Fantastic Four Marvel Super Heroes`. */
export function nameFromSlug(slug: string): string {
  const words = slug
    .replace(/-(commander-)?(precon-)?decklist$/, '')
    .split('-')
    .filter((word) => word !== '');
  return words
    .map((word, i) =>
      i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

export async function loadPremadeDecks(
  index: OracleIndex,
  banned: BannedList,
  fixtureDir?: string,
): Promise<TablePremadeDeck[]> {
  let known;
  try {
    known = await listKnownDecks(index, banned, fixtureDir);
  } catch (error) {
    // A missing deck folder costs the picker, never the table server.
    console.warn(`Premade decks unavailable: ${(error as Error).message}`);
    return [];
  }
  const check = createDeckChecker({ index, banned });
  return known
    .filter((deck) => check(deck.text).ok)
    .map((deck) => ({
      slug: deck.slug,
      name: deck.name === deck.slug ? nameFromSlug(deck.slug) : deck.name,
      commanderNames: deck.commanderNames,
      colorIdentity: [...deck.colorIdentity],
      archetypeTag: deck.archetypeTag,
      text: deck.text,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
