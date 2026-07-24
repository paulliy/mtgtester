/**
 * Companion deck-building conditions (brief §8.3, last bullet). Each of the ten companions
 * imposes a restriction on the *starting deck* (the 100 cards including the commander; the
 * companion itself sits outside). Color identity and singleton are enforced globally in
 * `validate.ts`; this module checks each companion's own condition.
 *
 * Conditions that can be read off oracle data are checked exactly. `Zirda` (every permanent has
 * an activated ability) is approximated by scanning for an activated-ability cost (`:`), which is
 * noted here and in the ADR. An unrecognized companion with a real "Companion —" ability is left
 * unverified rather than rejected — we never fail a deck on a rule we cannot evaluate.
 */

import type { OracleCard, ResolvedDeck, ValidationIssue } from '@mtg/shared';
import { strictKey } from '../cards/normalize';

const PERMANENT_TYPES = new Set([
  'Creature',
  'Artifact',
  'Enchantment',
  'Planeswalker',
  'Battle',
  'Land',
]);
const KAHEERA_TYPES = new Set(['Cat', 'Elemental', 'Nightmare', 'Dinosaur', 'Beast']);

const isLand = (c: OracleCard): boolean => c.types.includes('Land');
const isPermanent = (c: OracleCard): boolean => c.types.some((t) => PERMANENT_TYPES.has(t));

/** The starting-deck cards a companion condition ranges over: commanders + main deck. */
function startingDeck(deck: ResolvedDeck): OracleCard[] {
  return [...deck.commanders, ...deck.cards.map((e) => e.card)];
}

/** Extract mana-symbol strings from a cost like `"{2}{G}{G}"` → `["2","G","G"]`. */
function manaSymbols(manaCost: string | null): string[] {
  if (!manaCost) return [];
  return [...manaCost.matchAll(/\{([^}]+)\}/g)].map((m) => (m[1] ?? '').toUpperCase());
}

function issue(message: string): ValidationIssue {
  return { code: 'companion', message };
}

/** Report at most a few offending cards to keep the message readable. */
function offenders(cards: OracleCard[]): string {
  const names = cards.map((c) => c.name);
  return names.length <= 4
    ? names.join(', ')
    : `${names.slice(0, 4).join(', ')}, +${names.length - 4} more`;
}

type CompanionCheck = (deck: ResolvedDeck) => ValidationIssue[];

const CHECKS: Record<string, CompanionCheck> = {
  // Lurrus of the Dream-Den — every permanent card has mana value 2 or less.
  'lurrus of the dream-den': (deck) => {
    const bad = startingDeck(deck).filter((c) => isPermanent(c) && c.cmc > 2);
    return bad.length
      ? [
          issue(
            `Lurrus requires every permanent card have mana value 2 or less; violated by: ${offenders(bad)}.`,
          ),
        ]
      : [];
  },
  // Gyruda, Doom of Depths — only cards with even mana value.
  'gyruda, doom of depths': (deck) => {
    const bad = startingDeck(deck).filter((c) => c.cmc % 2 !== 0);
    return bad.length
      ? [
          issue(
            `Gyruda requires every card have an even mana value; violated by: ${offenders(bad)}.`,
          ),
        ]
      : [];
  },
  // Keruga, the Macrosage — each nonland card has mana value 3 or greater.
  'keruga, the macrosage': (deck) => {
    const bad = startingDeck(deck).filter((c) => !isLand(c) && c.cmc < 3);
    return bad.length
      ? [
          issue(
            `Keruga requires every nonland card have mana value 3 or greater; violated by: ${offenders(bad)}.`,
          ),
        ]
      : [];
  },
  // Obosh, the Preypiercer — each nonland card has an odd mana value.
  'obosh, the preypiercer': (deck) => {
    const bad = startingDeck(deck).filter((c) => !isLand(c) && c.cmc % 2 === 0);
    return bad.length
      ? [
          issue(
            `Obosh requires every nonland card have an odd mana value; violated by: ${offenders(bad)}.`,
          ),
        ]
      : [];
  },
  // Jegantha, the Wellspring — no card's mana cost has the same mana symbol twice.
  'jegantha, the wellspring': (deck) => {
    const bad = startingDeck(deck).filter((c) => {
      const counts = new Map<string, number>();
      for (const sym of manaSymbols(c.manaCost)) {
        if (/^\d+$/.test(sym) || sym === 'X' || sym === 'Y' || sym === 'Z') continue;
        counts.set(sym, (counts.get(sym) ?? 0) + 1);
      }
      return [...counts.values()].some((n) => n >= 2);
    });
    return bad.length
      ? [
          issue(
            `Jegantha requires no card repeat a mana symbol in its cost; violated by: ${offenders(bad)}.`,
          ),
        ]
      : [];
  },
  // Kaheera, the Orphanguard — each creature is Cat, Elemental, Nightmare, Dinosaur, or Beast.
  'kaheera, the orphanguard': (deck) => {
    const bad = startingDeck(deck).filter(
      (c) => c.types.includes('Creature') && !c.subtypes.some((t) => KAHEERA_TYPES.has(t)),
    );
    return bad.length
      ? [
          issue(
            `Kaheera requires every creature be a Cat, Elemental, Nightmare, Dinosaur, or Beast; violated by: ${offenders(bad)}.`,
          ),
        ]
      : [];
  },
  // Umori, the Collector — all nonland cards share a card type.
  'umori, the collector': (deck) => {
    const nonland = startingDeck(deck).filter((c) => !isLand(c));
    if (nonland.length === 0) return [];
    let shared = new Set(nonland[0]!.types);
    for (const c of nonland.slice(1)) shared = new Set(c.types.filter((t) => shared.has(t)));
    return shared.size === 0
      ? [issue('Umori requires every nonland card share a card type; the deck has no common type.')]
      : [];
  },
  // Zirda, the Dawnwaker — every permanent card has an activated ability (approximated).
  'zirda, the dawnwaker': (deck) => {
    const bad = startingDeck(deck).filter(
      (c) => isPermanent(c) && !isLand(c) && !/[^:]:\s/.test(c.oracleText),
    );
    return bad.length
      ? [
          issue(
            `Zirda requires every permanent card have an activated ability; likely violated by: ${offenders(bad)} (approximate check).`,
          ),
        ]
      : [];
  },
  // Yorion, Sky Nomad — starting deck at least 20 cards over the minimum (120 in Commander).
  'yorion, sky nomad': (deck) => {
    const count = deck.commanders.length + deck.cards.reduce((s, e) => s + e.quantity, 0);
    return count < 120
      ? [issue(`Yorion requires a starting deck of at least 120 cards; this deck has ${count}.`)]
      : [];
  },
  // Lutri, the Spellchaser — singleton, which Commander already enforces globally.
  'lutri, the spellchaser': () => [],
};

/**
 * Validate a companion's deck-building condition. Returns issues, or an empty array when the
 * condition is met (or cannot be evaluated for an unrecognized-but-valid companion).
 */
export function companionConditionIssues(
  companion: OracleCard,
  deck: ResolvedDeck,
): ValidationIssue[] {
  if (!/companion\s*[—-]/i.test(companion.oracleText)) {
    return [issue(`${companion.name} is not a companion (it has no "Companion —" ability).`)];
  }
  const check = CHECKS[strictKey(companion.name)];
  return check ? check(deck) : [];
}
