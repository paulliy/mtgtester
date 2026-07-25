/**
 * The engine-supported card pool.
 *
 * The engine halts on any unmodeled card in a deciding player's hand (brief §6.3), which makes
 * deck playability all-or-nothing: a decklist with one unmodeled card cannot be simulated at
 * all. Chasing coverage across arbitrary real decks does not converge — 94% of unparsed rules
 * lines occur on exactly one card — so the tractable path to a *running* simulator is to invert
 * the problem: enumerate what the engine already models and build legal decks from that.
 *
 * This module answers "what can the engine actually play with", so Phase 3 (the AI) has games
 * to run against while card coverage grows independently underneath it.
 */

import type { Color, OracleCard } from '@mtg/shared';
import { interpretCard } from '@mtg/engine';

/** A commander-legal, fully-modeled card, tagged with what a deck builder needs. */
export interface PoolCard {
  card: OracleCard;
  /** Sorted color-identity letters, `''` for colorless (CR 903.4). */
  identity: string;
  isLand: boolean;
  isBasicLand: boolean;
  /** Legendary creature — eligible to be a commander (CR 903.3). */
  canBeCommander: boolean;
  /** Exempt from the singleton rule (CR 903.5b). */
  unlimited: boolean;
}

export interface SupportedPool {
  cards: PoolCard[];
  /** Cards considered (commander-legal), for reporting the modeled fraction. */
  considered: number;
}

const identityOf = (card: OracleCard): string => [...card.colorIdentity].sort().join('');

/** CR 903.5b: basic lands, and cards whose text overrides the deck limit, dodge singleton. */
function isUnlimited(card: OracleCard): boolean {
  return card.isBasicLand || /a deck can have any number of cards named/i.test(card.oracleText);
}

/**
 * Filter a card set down to what the engine can actually play. Banned and non-legal cards are
 * excluded first so the modeled fraction reported is against a commander-legal denominator.
 */
export function buildSupportedPool(cards: Iterable<OracleCard>): SupportedPool {
  const pool: PoolCard[] = [];
  let considered = 0;

  for (const card of cards) {
    if (card.commanderLegality !== 'legal' && card.commanderLegality !== 'restricted') continue;
    considered++;
    if (!interpretCard(card).modeled) continue;

    pool.push({
      card,
      identity: identityOf(card),
      isLand: card.types.includes('Land'),
      isBasicLand: card.isBasicLand,
      canBeCommander: card.supertypes.includes('Legendary') && card.types.includes('Creature'),
      unlimited: isUnlimited(card),
    });
  }

  return { cards: pool, considered };
}

/** Is `card` playable in a deck of `identity`? CR 903.4 — its identity must be a subset. */
export function withinIdentity(card: PoolCard, identity: string): boolean {
  return [...card.identity].every((c) => identity.includes(c));
}

/** Cards legal in a deck of the given color identity, excluding the commander itself. */
export function poolForIdentity(pool: SupportedPool, identity: string): PoolCard[] {
  return pool.cards.filter((c) => withinIdentity(c, identity));
}

/** Every commander the pool supports, sorted by name for deterministic enumeration. */
export function commandersIn(pool: SupportedPool): PoolCard[] {
  return pool.cards
    .filter((c) => c.canBeCommander)
    .sort((a, b) => a.card.name.localeCompare(b.card.name));
}

/** The basic land for each color, if the pool has it — the mana base of a generated deck. */
export function basicLandsByColor(pool: SupportedPool): Map<Color, PoolCard> {
  const byName: Record<string, Color> = {
    Plains: 'W',
    Island: 'U',
    Swamp: 'B',
    Mountain: 'R',
    Forest: 'G',
  };
  const found = new Map<Color, PoolCard>();
  for (const entry of pool.cards) {
    const color = byName[entry.card.name];
    if (color !== undefined && entry.isBasicLand && !found.has(color)) found.set(color, entry);
  }
  return found;
}
