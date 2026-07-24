/**
 * Commander deck validation (brief §8.3). Validates a *resolved* deck against
 * `docs/rules/commander-rules.md` and the banned list, and reports **every** problem it finds,
 * not just the first — so a user fixing a deck sees the whole list at once.
 *
 * Rules implemented: exact card count (100, or 101 with a companion), legal commander(s),
 * Partner / Partner-with / Background pairings, singleton (with basic-land and text overrides),
 * color-identity subset, banned cards, and the companion deck-building condition.
 */

import type {
  Color,
  OracleCard,
  ResolvedDeck,
  ValidationIssue,
  ValidationResult,
} from '@mtg/shared';
import { strictKey } from '../cards/normalize';
import type { BannedList } from './banned';
import { companionConditionIssues } from './companions';

function isLegendaryCreature(card: OracleCard): boolean {
  return card.supertypes.includes('Legendary') && card.types.includes('Creature');
}

/** A card usable as a sole commander (CR 903.3): a legendary creature or explicit permission. */
export function isLegalSoloCommander(card: OracleCard): boolean {
  return isLegendaryCreature(card) || /can be your commander/i.test(card.oracleText);
}

function hasPlainPartner(card: OracleCard): boolean {
  return (
    /(^|\n|\band\b )partner\b(?! with)/i.test(card.oracleText) || card.keywords.includes('Partner')
  );
}

function partnerWithTarget(card: OracleCard): string | null {
  const match = /partner with ([^\n(.,]+)/i.exec(card.oracleText);
  return match?.[1]?.trim() ?? null;
}

const isBackground = (card: OracleCard): boolean => card.subtypes.includes('Background');
const choosesBackground = (card: OracleCard): boolean =>
  /choose a background/i.test(card.oracleText);
const isDoctor = (card: OracleCard): boolean => card.subtypes.includes('Doctor');
const hasDoctorCompanion = (card: OracleCard): boolean =>
  /doctor's companion/i.test(card.oracleText);

/** Whether two declared commanders form a legal pairing (CR 702.124 / 702.125 / backgrounds). */
function isLegalPairing(a: OracleCard, b: OracleCard): boolean {
  if (hasPlainPartner(a) && hasPlainPartner(b)) return true;
  const aWith = partnerWithTarget(a);
  const bWith = partnerWithTarget(b);
  if (
    aWith &&
    bWith &&
    strictKey(aWith) === strictKey(b.name) &&
    strictKey(bWith) === strictKey(a.name)
  ) {
    return true;
  }
  if ((choosesBackground(a) && isBackground(b)) || (choosesBackground(b) && isBackground(a)))
    return true;
  if ((hasDoctorCompanion(a) && isDoctor(b)) || (hasDoctorCompanion(b) && isDoctor(a))) return true;
  return false;
}

/** A card exempt from singleton: a basic land, or text that overrides the limit (CR 903.5b). */
function allowsAnyQuantity(card: OracleCard): boolean {
  return card.isBasicLand || /a deck can have any number of cards named/i.test(card.oracleText);
}

/** Union of the commanders' color identities — the deck's legal identity (CR 903.4). */
function commanderIdentity(commanders: OracleCard[]): Set<Color> {
  const set = new Set<Color>();
  for (const c of commanders) for (const color of c.colorIdentity) set.add(color);
  return set;
}

/** One entry per distinct card with its total copies across command zone, companion, and deck. */
interface CardTally {
  card: OracleCard;
  count: number;
}

function tallyCards(deck: ResolvedDeck): Map<string, CardTally> {
  const tally = new Map<string, CardTally>();
  const add = (card: OracleCard, n: number): void => {
    const existing = tally.get(card.oracleId);
    if (existing) existing.count += n;
    else tally.set(card.oracleId, { card, count: n });
  };
  for (const c of deck.commanders) add(c, 1);
  if (deck.companion) add(deck.companion, 1);
  for (const entry of deck.cards) add(entry.card, entry.quantity);
  return tally;
}

export function validateDeck(deck: ResolvedDeck, banned: BannedList): ValidationResult {
  const issues: ValidationIssue[] = [];
  const tally = tallyCards(deck);

  // 1. Card count — 100 including commander(s), 101 with a companion.
  const mainQty = deck.cards.reduce((sum, e) => sum + e.quantity, 0);
  const total = mainQty + deck.commanders.length + (deck.companion ? 1 : 0);
  const expected = deck.companion ? 101 : 100;
  if (total !== expected) {
    issues.push({
      code: 'cardCount',
      message: `Deck has ${total} cards; a Commander deck must have exactly ${expected}${
        deck.companion ? ' (100 + companion)' : ''
      }.`,
    });
  }

  // 2 & 3. Commander legality and partner/background pairing.
  if (deck.commanders.length === 0) {
    issues.push({ code: 'commanderLegality', message: 'No commander was designated.' });
  } else if (deck.commanders.length === 1) {
    const cmd = deck.commanders[0]!;
    if (!isLegalSoloCommander(cmd)) {
      issues.push({
        code: 'commanderLegality',
        cardName: cmd.name,
        message: `${cmd.name} is not a legal commander (not a legendary creature and lacks "can be your commander").`,
      });
    }
  } else if (deck.commanders.length === 2) {
    const [a, b] = [deck.commanders[0]!, deck.commanders[1]!];
    if (!isLegalPairing(a, b)) {
      issues.push({
        code: 'partnerPairing',
        message: `${a.name} and ${b.name} are not a legal pair (need Partner, matching Partner-with, or a Background pairing).`,
      });
    }
  } else {
    issues.push({
      code: 'partnerPairing',
      message: `Too many commanders (${deck.commanders.length}); at most two are allowed via Partner/Background.`,
    });
  }

  // 4. Singleton.
  for (const { card, count } of tally.values()) {
    if (count > 1 && !allowsAnyQuantity(card)) {
      issues.push({
        code: 'singleton',
        cardName: card.name,
        message: `${card.name} appears ${count} times; only one copy is allowed (singleton).`,
      });
    }
  }

  // 5. Color identity subset.
  if (deck.commanders.length > 0) {
    const identity = commanderIdentity(deck.commanders);
    for (const { card } of tally.values()) {
      const outside = card.colorIdentity.filter((c) => !identity.has(c));
      if (outside.length > 0) {
        issues.push({
          code: 'colorIdentity',
          cardName: card.name,
          message: `${card.name} has color identity {${card.colorIdentity.join('')}}, outside the commander's {${[
            ...identity,
          ].join('')}}.`,
        });
      }
    }
  }

  // 6. Banned cards (authoritative list + defensive Scryfall legality signal).
  for (const { card } of tally.values()) {
    if (banned.isBanned(card.name)) {
      issues.push({
        code: 'banned',
        cardName: card.name,
        message: `${card.name} is on the Commander banned list.`,
      });
    } else if (card.commanderLegality === 'banned') {
      issues.push({
        code: 'banned',
        cardName: card.name,
        message: `${card.name} is banned in Commander (Scryfall).`,
      });
    } else if (card.commanderLegality === 'not_legal') {
      issues.push({
        code: 'banned',
        cardName: card.name,
        message: `${card.name} is not legal in the Commander card pool.`,
      });
    }
  }

  // 7. Companion deck-building condition (color identity + singleton already checked above).
  if (deck.companion) {
    issues.push(...companionConditionIssues(deck.companion, deck));
  }

  return { valid: issues.length === 0, issues };
}
