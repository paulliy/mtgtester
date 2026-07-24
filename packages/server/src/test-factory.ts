/**
 * Test fixtures for the deck pipeline. Not a spec file (no `.test`/`.spec` suffix) so the runner
 * ignores it; it just builds `OracleCard`s and `ResolvedDeck`s with sensible defaults so tests
 * can state only the fields that matter to them.
 */

import type { OracleCard, ResolvedDeck, ResolvedDeckEntry } from '@mtg/shared';

export function makeOracleCard(over: Partial<OracleCard> & { name: string }): OracleCard {
  return {
    oracleId: over.name,
    scryfallId: over.name,
    manaCost: null,
    cmc: 0,
    colors: [],
    colorIdentity: [],
    typeLine: '',
    supertypes: [],
    types: [],
    subtypes: [],
    oracleText: '',
    power: null,
    toughness: null,
    loyalty: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
    ...over,
  };
}

/** A basic Forest (color identity G, singleton-exempt). */
export function forest(n = 1): OracleCard {
  return makeOracleCard({
    name: `Forest`,
    oracleId: `forest-${n}`, // distinct ids are irrelevant; basics are exempt from singleton
    typeLine: 'Basic Land — Forest',
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: ['Forest'],
    colorIdentity: ['G'],
    isBasicLand: true,
  });
}

/** Build a resolved deck from a commander plus main-deck entries, defaulting the rest. */
export function makeResolvedDeck(over: {
  commanders: OracleCard[];
  cards: ResolvedDeckEntry[];
  companion?: OracleCard | null;
}): ResolvedDeck {
  return {
    sourceType: 'plaintext',
    sourceUrl: null,
    name: 'Test Deck',
    archetypeTag: null,
    commanders: over.commanders,
    companion: over.companion ?? null,
    cards: over.cards,
  };
}

/** N distinct singleton filler creatures of a given identity, for padding a deck to 100. */
export function fillerCreatures(
  count: number,
  colorIdentity: OracleCard['colorIdentity'] = ['G'],
): ResolvedDeckEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    quantity: 1,
    card: makeOracleCard({
      name: `Filler ${i + 1}`,
      typeLine: 'Creature — Elf',
      types: ['Creature'],
      subtypes: ['Elf'],
      cmc: 3,
      colorIdentity,
    }),
  }));
}
