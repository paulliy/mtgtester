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

/** The pairing ability a card carries for two-commander decks (CR 702.124). */
type PairAbility =
  | { kind: 'partner' }
  | { kind: 'partnerWith'; name: string }
  | { kind: 'partnerVariant'; variant: string }
  | { kind: 'friendsForever' }
  | { kind: 'chooseBackground' }
  | { kind: 'doctorsCompanion' };

/**
 * Reads the pairing abilities from oracle text only. Scryfall's `keywords` lists "Partner" for
 * "Partner with" and "Partner—<variant>" cards too, which would let either pair with any plain
 * partner (forbidden by CR 702.124f), so it is not consulted.
 */
export function pairAbilities(card: OracleCard): PairAbility[] {
  const found: PairAbility[] = [];
  for (const rawLine of card.oracleText.split('\n')) {
    const line = rawLine.replace(/\([^)]*\)/g, '').trim();
    // The partner's name may hold a comma ("Partner with Pippin, Guard of the Citadel").
    if (line.toLowerCase().startsWith('partner with ')) {
      found.push({ kind: 'partnerWith', name: line.slice('partner with '.length).trim() });
      continue;
    }
    for (const rawPart of line.split(/,\s*/)) {
      const part = rawPart.trim();
      const lower = part.toLowerCase();
      if (lower === 'partner') found.push({ kind: 'partner' });
      else if (lower.startsWith('partner with ')) {
        found.push({ kind: 'partnerWith', name: part.slice('partner with '.length).trim() });
      } else if (/^partner\s*[—-]\s*\S/.test(lower)) {
        found.push({ kind: 'partnerVariant', variant: lower.replace(/^partner\s*[—-]\s*/, '') });
      } else if (lower === 'friends forever') found.push({ kind: 'friendsForever' });
      else if (lower === 'choose a background') found.push({ kind: 'chooseBackground' });
      else if (lower === "doctor's companion") found.push({ kind: 'doctorsCompanion' });
    }
  }
  return found;
}

const has = (card: OracleCard, kind: PairAbility['kind']): boolean =>
  pairAbilities(card).some((ability) => ability.kind === kind);

const isBackground = (card: OracleCard): boolean =>
  card.supertypes.includes('Legendary') &&
  card.types.includes('Enchantment') &&
  card.subtypes.includes('Background');

/**
 * A Time Lord Doctor creature with no other creature types (CR 702.124m). The importer splits
 * subtypes on whitespace, so "Time Lord" arrives as "Time" and "Lord"; both spellings count.
 */
const isPureTimeLordDoctor = (card: OracleCard): boolean => {
  const subtypes = new Set(card.subtypes);
  const timeLord = subtypes.has('Time Lord') || (subtypes.has('Time') && subtypes.has('Lord'));
  return (
    isLegendaryCreature(card) &&
    subtypes.has('Doctor') &&
    timeLord &&
    [...subtypes].every((t) => ['Doctor', 'Time Lord', 'Time', 'Lord'].includes(t))
  );
};

function partnersWith(a: OracleCard, b: OracleCard): boolean {
  return pairAbilities(a).some(
    (ability) => ability.kind === 'partnerWith' && strictKey(ability.name) === strictKey(b.name),
  );
}

function sameVariant(a: OracleCard, b: OracleCard): boolean {
  const variants = new Set(
    pairAbilities(a).flatMap((ability) =>
      ability.kind === 'partnerVariant' ? [ability.variant] : [],
    ),
  );
  return pairAbilities(b).some(
    (ability) => ability.kind === 'partnerVariant' && variants.has(ability.variant),
  );
}

/**
 * Whether two declared commanders form a legal pairing (CR 702.124). Each kind pairs only with
 * the same kind: plain Partner with plain Partner, "Partner with X" only with X (and X back),
 * Partner—variant with the same variant, Friends forever with Friends forever, "Choose a
 * Background" with a legendary Background enchantment, and Doctor's companion with a Time Lord
 * Doctor. Every partner-style half must itself be able to be a commander.
 */
function isLegalPairing(a: OracleCard, b: OracleCard): boolean {
  if (a.oracleId === b.oracleId) return false;
  const pair = (x: OracleCard, y: OracleCard): boolean => {
    if (has(x, 'chooseBackground') && isLegendaryCreature(x) && isBackground(y)) return true;
    if (has(x, 'doctorsCompanion') && isLegendaryCreature(x) && isPureTimeLordDoctor(y))
      return true;
    return false;
  };
  if (pair(a, b) || pair(b, a)) return true;
  if (!isLegalSoloCommander(a) || !isLegalSoloCommander(b)) return false;
  if (has(a, 'partner') && has(b, 'partner')) return true;
  if (partnersWith(a, b) && partnersWith(b, a)) return true;
  if (sameVariant(a, b)) return true;
  if (has(a, 'friendsForever') && has(b, 'friendsForever')) return true;
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
