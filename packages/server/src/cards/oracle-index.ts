/**
 * The in-memory oracle-card index used to resolve decklist names (brief §8.2). Built once from
 * the Scryfall bulk file at import time; games never read the bulk file (§3) — they read the
 * SQLite card cache that resolution populates.
 *
 * Resolution is deliberately conservative: strict key first (apostrophes + case), then a loose
 * key (diacritics, punctuation, front-face) *only when it is unambiguous*. On any miss we report
 * the name and never guess (§8.2 step 2).
 */

import type { OracleCard } from '@mtg/shared';
import { looseKey, strictKey } from './normalize';
import { toOracleCard, type RawScryfallCard } from './scryfall';

export interface OracleIndex {
  /** Total resolvable cards indexed. */
  readonly size: number;
  /** Resolve one name, or `null` if it does not resolve unambiguously. */
  resolve(name: string): OracleCard | null;
  /** Look up a card by its oracle id (used to rehydrate a snapshot's card list). */
  getByOracleId(oracleId: string): OracleCard | null;
}

/**
 * Build an index from already-parsed raw cards. Pure and synchronous so it can be unit-tested
 * with a handful of fixtures instead of the 180 MB file.
 */
export function buildOracleIndex(rawCards: RawScryfallCard[]): OracleIndex {
  const cards: OracleCard[] = [];
  for (const raw of rawCards) {
    const card = toOracleCard(raw);
    if (card !== null) cards.push(card);
  }
  return buildOracleIndexFromCards(cards);
}

/**
 * Build an index from cards already in engine form — a committed Oracle fixture such as
 * `packages/server/fixtures/coverage-oracle.json`, which lets a server run without the bulk file.
 */
export function buildOracleIndexFromCards(cards: readonly OracleCard[]): OracleIndex {
  const byOracleId = new Map<string, OracleCard>();
  const byStrict = new Map<string, OracleCard>();
  const byLoose = new Map<string, OracleCard | null>(); // null marks an ambiguous loose key

  const addStrict = (key: string, card: OracleCard): void => {
    const existing = byStrict.get(key);
    // Prefer the full-name mapping; don't let a front-face alias overwrite an exact name.
    if (existing === undefined) {
      byStrict.set(key, card);
      return;
    }
    // Some names are printed on more than one distinct Oracle card — a Mystery Booster playtest
    // card, a promo, or an Unknown Event card sharing a name with a real one (e.g. "Pick Your
    // Poison": the {3}{B}{G} `cmb2` playtest card and the {G} Karlov Manor sorcery). Bulk order
    // decides who wins otherwise, so a decklist could silently resolve to a card that is not
    // legal in Commander and cannot be cast. Prefer the Commander-legal printing.
    const wasLegal = existing.commanderLegality !== 'not_legal';
    const isLegal = card.commanderLegality !== 'not_legal';
    if (isLegal && !wasLegal) byStrict.set(key, card);
  };
  const addLoose = (key: string, card: OracleCard): void => {
    if (!byLoose.has(key)) byLoose.set(key, card);
    else if (byLoose.get(key) !== card) byLoose.set(key, null); // collision → ambiguous
  };

  for (const card of cards) {
    if (byOracleId.has(card.oracleId)) continue; // oracle-cards is one-per-id; keep the first
    byOracleId.set(card.oracleId, card);

    addStrict(strictKey(card.name), card);
    addLoose(looseKey(card.name), card);

    // Index the front face of a `A // B` card so a front-only name still resolves.
    if (card.name.includes('//')) {
      const front = card.name.split('//')[0]?.trim();
      if (front) {
        addStrict(strictKey(front), card);
        addLoose(looseKey(front), card);
      }
    }
  }

  return {
    size: byOracleId.size,
    resolve(name: string): OracleCard | null {
      const strict = byStrict.get(strictKey(name));
      if (strict) return strict;
      const loose = byLoose.get(looseKey(name));
      return loose ?? null; // `null` (ambiguous) and `undefined` (miss) both mean "unresolved"
    },
    getByOracleId(oracleId: string): OracleCard | null {
      return byOracleId.get(oracleId) ?? null;
    },
  };
}
