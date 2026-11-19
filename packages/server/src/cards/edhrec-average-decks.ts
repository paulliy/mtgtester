/**
 * EDHREC average decks: the deck population for the deck-coverage metric.
 *
 * EDHREC publishes one "average deck" per commander, built from the decks it has seen for that
 * commander. `bun run edhrec:fetch --average-decks N` snapshots the top N commanders' average
 * decks into `edhrec-average-decks.json`; `bun run deck-coverage --pin` then copies the Oracle
 * record of every card in them from the local Scryfall bank into
 * `edhrec-average-decks-oracle.json`, so the metric runs offline and reproducibly.
 *
 * Average decks are a population sample, not real lists: they can miss or exceed 100 cards and
 * their basics are averaged. Never offer them as playable decks.
 */

import type { OracleCard } from '@mtg/shared';
import type { DeckInput } from './deck-coverage';
import type { OracleIndex } from './oracle-index';

export const AVERAGE_DECKS_PATH = 'packages/server/fixtures/edhrec-average-decks.json';
export const AVERAGE_DECKS_ORACLE_PATH =
  'packages/server/fixtures/edhrec-average-decks-oracle.json';

export interface AverageDeck {
  /** Position in EDHREC's commander ranking (past two years). */
  rank: number;
  slug: string;
  /** Decks EDHREC counted for this commander. */
  decks: number;
  commanders: string[];
  /** `[name, quantity]`, the 99 (or so) without the commanders. */
  cards: [string, number][];
}

export interface AverageDecksFixture {
  source: string;
  fetchedAt: string;
  decks: AverageDeck[];
}

/** One entry of EDHREC's commander ranking (`pages/commanders/year.json`). */
export interface EdhrecCommanderView {
  name: string;
  sanitized: string;
  num_decks: number;
}

/** The part of `pages/average-decks/<slug>.json` the fixture keeps. */
export interface EdhrecAverageDeckPage {
  deck?: {
    commander?: string[];
    /** Card type → `[name, quantity]` pairs. */
    cards?: Record<string, [string, number][]>;
  };
}

/** Commanders and cards of one average-deck page, or an error naming what is missing. */
export function parseAverageDeckPage(
  slug: string,
  page: EdhrecAverageDeckPage,
): Pick<AverageDeck, 'commanders' | 'cards'> {
  const commanders = page.deck?.commander;
  const byType = page.deck?.cards;
  if (!Array.isArray(commanders) || commanders.length === 0 || byType === undefined)
    throw new Error(`EDHREC average deck ${slug}: no deck.commander or deck.cards`);
  const quantities = new Map<string, number>();
  for (const pairs of Object.values(byType)) {
    for (const pair of pairs) {
      const [name, quantity] = pair;
      if (typeof name !== 'string' || !(Number.isInteger(quantity) && quantity > 0))
        throw new Error(`EDHREC average deck ${slug}: bad card entry ${JSON.stringify(pair)}`);
      quantities.set(name, (quantities.get(name) ?? 0) + quantity);
    }
  }
  for (const name of commanders) quantities.delete(name);
  const cards = [...quantities.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return { commanders: [...commanders], cards };
}

/** The fixture as written: one deck per line, so a refresh diff names the decks that changed. */
export function renderAverageDecks(fixture: AverageDecksFixture): string {
  const rows = fixture.decks.map((deck) => `    ${JSON.stringify(deck)}`).join(',\n');
  return (
    `{\n  "source": ${JSON.stringify(fixture.source)},\n` +
    `  "fetchedAt": ${JSON.stringify(fixture.fetchedAt)},\n` +
    `  "decks": [\n${rows}\n  ]\n}\n`
  );
}

/** Every distinct card name across the fixture, commanders included. */
export function averageDeckNames(fixture: AverageDecksFixture): string[] {
  const names = new Set<string>();
  for (const deck of fixture.decks) {
    for (const name of deck.commanders) names.add(name);
    for (const [name] of deck.cards) names.add(name);
  }
  return [...names].sort();
}

/**
 * The Oracle records of every card in the fixture, resolved in `index`, sorted by name. Names the
 * index cannot resolve (a renamed card, an Un-card) are returned separately.
 */
export function pinAverageDeckOracle(
  fixture: AverageDecksFixture,
  index: OracleIndex,
): { cards: OracleCard[]; unresolved: string[] } {
  const byId = new Map<string, OracleCard>();
  const unresolved: string[] = [];
  for (const name of averageDeckNames(fixture)) {
    const card = index.resolve(name);
    if (card === null) unresolved.push(name);
    else byId.set(card.oracleId, card);
  }
  const cards = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { cards, unresolved };
}

/** The pinned Oracle file: the records, and the names the bank could not resolve. */
export interface PinnedAverageDeckOracle {
  unresolved: string[];
  cards: OracleCard[];
}

/** The pinned Oracle file as written: one card per line. */
export function renderPinnedOracle(pinned: PinnedAverageDeckOracle): string {
  const cards = pinned.cards.map((card) => `    ${JSON.stringify(card)}`).join(',\n');
  return (
    `{\n  "unresolved": ${JSON.stringify(pinned.unresolved)},\n` +
    `  "cards": [${cards === '' ? '' : `\n${cards}\n  `}]\n}\n`
  );
}

/**
 * The fixture's decks as metric input, named by their commanders. A name the bank could not
 * resolve at pin time stays in the deck as an unresolved blocker, so it can never make a deck look
 * more playable. A name missing from the pinned file altogether means the pin is stale: that
 * fails loudly and asks for a re-pin.
 */
export function averageDeckInputs(
  fixture: AverageDecksFixture,
  index: OracleIndex,
  knownUnresolved: readonly string[],
): DeckInput[] {
  const unresolvable = new Set(knownUnresolved);
  const missing = new Set<string>();
  const decks = fixture.decks.map((deck) => {
    const cards: OracleCard[] = [];
    const unresolved: string[] = [];
    for (const name of [...deck.commanders, ...deck.cards.map(([cardName]) => cardName)]) {
      const card = index.resolve(name);
      if (card !== null) cards.push(card);
      else if (unresolvable.has(name)) unresolved.push(name);
      else missing.add(name);
    }
    return { name: deck.commanders.join(' + '), cards, unresolved };
  });
  if (missing.size > 0)
    throw new Error(
      `${missing.size} average-deck card(s) are not in the pinned Oracle file (${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? ', …' : ''}); run bun run deck-coverage --pin`,
    );
  return decks;
}
