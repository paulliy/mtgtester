/**
 * Deterministic Commander deck construction from the engine-supported card pool
 * (`cards/pool.ts`).
 *
 * Every generated deck is legal by construction — 100 cards, singleton outside basics, inside
 * the commander's color identity — and, critically, made only of cards the engine models, so it
 * plays end to end instead of halting (brief §6.3). `validateDeck` is still the authority; the
 * CLI runs generated decks through it rather than trusting this module.
 *
 * Seeded throughout (brief §4/§5.9 — no `Math.random` anywhere in deck or game construction):
 * the same seed always yields the same decklist, so a reported game is reproducible.
 */

import type { Color, OracleCard, ParsedDeck } from '@mtg/shared';
import { Prng } from '@mtg/engine';
import {
  basicLandsByColor,
  commandersIn,
  poolForIdentity,
  type PoolCard,
  type SupportedPool,
} from '../cards/pool';

/** A Commander deck is exactly 100 cards including the commander (CR 903.5a). */
const DECK_SIZE = 100;

export interface GenerateOptions {
  seed: string;
  /** Force a commander by exact name; otherwise one is chosen from the pool by seed. */
  commanderName?: string;
  /** Lands in the 99 (basics fill this). Real precons sit around 36. */
  landCount?: number;
}

export interface GeneratedDeck {
  commander: OracleCard;
  /** The 99, including lands. */
  cards: OracleCard[];
}

/** Fisher–Yates over a copy, driven by the seeded PRNG so the order is reproducible. */
function shuffled<T>(items: readonly T[], rng: Prng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Build one legal Commander deck.
 *
 * Throws when the pool cannot support a legal deck rather than emitting an illegal one — a
 * silently-short deck would fail deep inside the engine instead of here.
 */
export function generateCommanderDeck(
  pool: SupportedPool,
  options: GenerateOptions,
): GeneratedDeck {
  const rng = new Prng(options.seed);
  const landCount = options.landCount ?? 36;

  const candidates = commandersIn(pool);
  if (candidates.length === 0) {
    throw new Error('the supported pool contains no legendary creature to use as a commander');
  }

  const commander =
    options.commanderName === undefined
      ? (shuffled(candidates, rng)[0] as PoolCard)
      : candidates.find((c) => c.card.name === options.commanderName);
  if (commander === undefined) {
    throw new Error(
      `"${options.commanderName}" is not a modeled legendary creature in the supported pool`,
    );
  }

  const identity = commander.identity;

  // Mana base: basics only. They are singleton-exempt (CR 903.5b), so they can fill any
  // amount, and a colorless commander still needs lands — fall back to Wastes-less mono-white
  // is not possible, so a colorless identity uses no basics and leans on the nonland pool.
  const basics = basicLandsByColor(pool);
  const colors = [...identity] as Color[];
  const lands: OracleCard[] = [];
  if (colors.length > 0) {
    for (let i = 0; i < landCount; i++) {
      const color = colors[i % colors.length] as Color;
      const basic = basics.get(color);
      if (basic !== undefined) lands.push(basic.card);
    }
  }

  // The rest: distinct nonland cards inside the identity, excluding the commander itself.
  const spellPool = poolForIdentity(pool, identity).filter(
    (c) => !c.isLand && c.card.oracleId !== commander.card.oracleId,
  );
  const needed = DECK_SIZE - 1 - lands.length;
  if (spellPool.length < needed) {
    throw new Error(
      `pool for identity {${identity || 'C'}} has ${spellPool.length} nonland cards, ` +
        `need ${needed} — lower landCount or widen the pool`,
    );
  }

  const spells = shuffled(spellPool, rng)
    .slice(0, needed)
    .map((c) => c.card);

  return { commander: commander.card, cards: [...lands, ...spells] };
}

/** Render a generated deck as a `ParsedDeck`, ready for `resolveDeck`/`validateDeck`. */
export function toParsedDeck(deck: GeneratedDeck, name: string): ParsedDeck {
  const counts = new Map<string, number>();
  for (const card of deck.cards) counts.set(card.name, (counts.get(card.name) ?? 0) + 1);
  return {
    sourceType: 'plaintext',
    sourceUrl: null,
    name,
    commanderNames: [deck.commander.name],
    companionName: null,
    cards: [...counts.entries()].map(([cardName, quantity]) => ({ name: cardName, quantity })),
    archetypeTag: null,
  };
}

/** Render as the plaintext fixture format, so a generated deck can be committed and re-run. */
export function toPlaintext(deck: GeneratedDeck, name: string): string {
  const parsed = toParsedDeck(deck, name);
  const lines = [`# ${name}`, '# generated from the engine-supported card pool', ''];
  lines.push('Commander', `1 ${deck.commander.name}`, '', 'Deck');
  for (const entry of parsed.cards) lines.push(`${entry.quantity} ${entry.name}`);
  return `${lines.join('\n')}\n`;
}
