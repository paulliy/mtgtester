/**
 * Amount phrases for the card grammar (ADR 0038): the counts and quantities rules text writes in
 * an amount position ("two", "X", "that many", "the number of creatures you control", "your
 * devotion to black"), parsed to a `Value`. A phrase this module does not know returns null, and
 * null leaves the card unmodeled.
 */

import type { Color, OracleCard } from '@mtg/shared';
import { COLOR_WORDS, parseAmount } from './words';
import { parseCardFilterPhrase, parseSubject } from './subject';
import { ENTERED_THIS_TURN, YOURS, allOf } from '../selector';
import type { Value } from '../value';
import { constant } from '../value';
import { noteSlotFailure } from './diagnostics';

/**
 * A count as rules text writes it, including the back-references only an event can answer.
 *
 * **"That many" is not one thing.** It refers back to the most recent quantity in the trigger
 * head, and which quantity that is depends on the head:
 *
 *   "Whenever one or more Dragons you control attack, draw **that many** cards"   → how many
 *   "Whenever a creature deals combat damage to a player, create **that many**    → how much
 *    Treasure tokens"
 *
 * So the referent is supplied by the caller (`thatMany`) rather than guessed here. Guessing
 * would make Old Gnawbone produce one Treasure per hit instead of one per damage — a silent
 * undercount, not an error.
 */
function parseCountPhraseUntraced(phrase: string, thatMany?: Value): Value | null {
  if (phrase === 'that many' || phrase === 'that much' || phrase === 'that damage') {
    return thatMany ?? null;
  }
  if (phrase === 'x') return { kind: 'xValue' };
  const n = parseAmount(phrase);
  return n === null ? null : constant(n);
}

/** Parse count clauses that depend on the source, trigger object, or current battlefield. */
function parseDynamicCountValueUntraced(
  clause: string,
  card: OracleCard,
  opts: { triggerObject?: boolean } = {},
): Value | null {
  // Scryfall prints the typographic apostrophe; every literal below is written with the
  // straight one, and "~’s power" would otherwise miss.
  const text = clause.trim().toLowerCase().replace(/’/g, "'");
  const totalPower = text.match(/^the total power of (.+)$/);
  if (totalPower !== null) {
    const selector = parseSubject(totalPower[1] as string, card);
    if (selector !== null) return { kind: 'totalPowerAmong', selector, scope: 'all' };
  }
  const devotion = text.match(/^your devotion to (white|blue|black|red|green)$/);
  if (devotion !== null)
    return { kind: 'devotionTo', color: COLOR_WORDS[devotion[1] as string] as Color };
  // The singular reaches here from the "gets +1/+1 **for each color** among permanents you
  // control" buff parse (Faeburrow Elder), which prefixes its clause with "the number of ".
  if (/^the number of colou?rs? among permanents you control$/.test(text)) {
    return { kind: 'colorsAmongPermanents' };
  }
  if (
    /^the number of colors among permanents you control and spells you've cast this turn$/.test(
      text,
    )
  ) {
    return { kind: 'colorsAmongPermanentsAndSpellsCastThisTurn' };
  }
  const opponents = text.match(/^(?:the )?number of opponents$/);
  if (opponents !== null) return { kind: 'countOpponents' };
  const cardsInYourZone = text.match(
    /^the number of (.+ cards?) in your (graveyard|hand|library)$/,
  );
  if (cardsInYourZone !== null) {
    const selector = parseCardFilterPhrase(cardsInYourZone[1] as string, card);
    if (selector !== null) {
      return {
        kind: 'countCardsInZone',
        zone: cardsInYourZone[2] as 'graveyard' | 'hand' | 'library',
        selector,
        owner: 'you',
      };
    }
  }
  const entered = text.match(
    /^(?:the )?number of (.+) that entered the battlefield under your control this turn$/,
  );
  if (entered !== null) {
    const selector = parseSubject(entered[1] as string, card);
    if (selector !== null)
      return {
        kind: 'countPermanents',
        selector: allOf(selector, YOURS, ENTERED_THIS_TURN),
        scope: 'all',
      };
  }
  const plus = text.match(/^one plus the number of (.+)$/);
  if (plus !== null) {
    const base = parseDynamicCountValue('the number of ' + (plus[1] as string), card, opts);
    return base === null ? null : { kind: 'plus', of: base, n: 1 };
  }
  // "for each tapped land your opponents control" (Mana Geyser): tapped permanents, scoped by
  // the subject the same way the untapped count below is.
  const tapped = text.match(/^(?:the )?number of tapped (.+)$/);
  if (tapped !== null) {
    const noun = tapped[1] as string;
    const selector = parseSubject(noun, card);
    if (selector !== null)
      return {
        kind: 'countTappedPermanents',
        selector,
        scope: /\byour opponents control\b|\ban opponent controls\b/.test(noun)
          ? 'opponents'
          : /\byou control\b/.test(noun)
            ? 'you'
            : 'all',
      };
  }
  const number = text.match(/^(?:the )?number of (.+)$/);
  if (number !== null) {
    const noun = number[1] as string;
    const selector = parseSubject(noun, card);
    if (selector !== null) {
      // The scope has to follow the subject. Defaulting to 'you' intersects an explicitly
      // opposing subject ("creatures your opponents control") with a you-only filter and counts
      // a constant 0 — silently, with the card still reporting modeled.
      const scope: 'you' | 'opponents' | 'all' =
        /\byour opponents control\b|\ban opponent controls\b/.test(noun)
          ? 'opponents'
          : /\byou control\b/.test(noun)
            ? 'you'
            : 'all';
      return { kind: 'countPermanents', selector, scope };
    }
  }
  if (text === "~'s power" || text === "this creature's power") return { kind: 'powerOfSource' };
  if (text === "~'s toughness" || text === "this creature's toughness")
    return { kind: 'toughnessOfSource' };
  if (opts.triggerObject === true && (text === 'its power' || text === "that creature's power")) {
    return { kind: 'powerOfTriggerObject' };
  }
  const counters = text.match(
    /^(?:the number of )?([+-][0-9]+[/][+-][0-9]+|[a-z]+) counters? on (?:~|this (?:creature|artifact|enchantment|land|permanent)|it)$/,
  );
  if (counters !== null) {
    return opts.triggerObject === true && text.endsWith('on it')
      ? { kind: 'countersOnTriggerObject', counter: counters[1] as string }
      : { kind: 'countersOnSelf', counter: counters[1] as string };
  }
  if (text === 'the number of opponents who lost life this turn')
    return { kind: 'opponentsLostLifeThisTurn' };
  // EDHREC plan Phase 4 batch 5: value phrases the amount forms reach most often.
  if (text === 'the number of opponents you have') return { kind: 'countOpponents' };
  if (text === 'your life total') return { kind: 'lifeTotal', scope: 'you' };
  if (text === 'the number of card types among cards in your graveyard')
    return { kind: 'cardTypesInYourGraveyard' };
  // "the number of cards in your hand": every card there (an empty `allOf` matches anything).
  const cardsInZone = text.match(/^the number of cards in your (graveyard|hand|library)$/);
  if (cardsInZone !== null)
    return {
      kind: 'countCardsInZone',
      zone: cardsInZone[1] as 'graveyard' | 'hand' | 'library',
      selector: { kind: 'allOf', of: [] },
      owner: 'you',
    };
  // "the greatest power among creatures you control" (Overwhelming Stampede); 0 with none.
  const greatest = text.match(/^the greatest (power|toughness|mana value) among (.+)$/);
  if (greatest !== null) {
    const noun = greatest[2] as string;
    const selector = parseSubject(noun, card);
    if (selector !== null) {
      const scope: 'you' | 'opponents' | 'all' =
        /\byour opponents control\b|\ban opponent controls\b/.test(noun)
          ? 'opponents'
          : /\byou control\b/.test(noun)
            ? 'you'
            : 'all';
      return {
        kind:
          greatest[1] === 'power'
            ? 'greatestPowerAmong'
            : greatest[1] === 'toughness'
              ? 'greatestToughnessAmong'
              : 'greatestManaValueAmong',
        selector,
        scope,
      };
    }
  }
  return null;
}

/**
 * A damage amount as printed: a number word, or `X` (the announced value, CR 601.2b).
 *
 * Returns a `Value` rather than a number so "X damage" and "3 damage" take the same executor
 * path — the alternative is a parallel set of ops that differ only in how the number arrives.
 */
function parseDamageAmountUntraced(word: string, card: OracleCard): Value | null {
  if (word === 'x') {
    // Only meaningful on a card whose own cost contains {X}; anything else is a different X
    // (an ability's X, a counted quantity) that this grammar has not read.
    return (card.manaCost ?? '').includes('{X}') ? { kind: 'xValue' } : null;
  }
  const amount = parseAmount(word);
  return amount === null ? null : constant(amount);
}

/** `parseCountPhraseUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseCountPhrase(
  ...args: Parameters<typeof parseCountPhraseUntraced>
): ReturnType<typeof parseCountPhraseUntraced> {
  const result = parseCountPhraseUntraced(...args);
  if (result === null) noteSlotFailure('amount', args[0]);
  return result;
}

/** `parseDynamicCountValueUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseDynamicCountValue(
  ...args: Parameters<typeof parseDynamicCountValueUntraced>
): ReturnType<typeof parseDynamicCountValueUntraced> {
  const result = parseDynamicCountValueUntraced(...args);
  if (result === null) noteSlotFailure('amount', args[0]);
  return result;
}

/** `parseDamageAmountUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseDamageAmount(
  ...args: Parameters<typeof parseDamageAmountUntraced>
): ReturnType<typeof parseDamageAmountUntraced> {
  const result = parseDamageAmountUntraced(...args);
  if (result === null) noteSlotFailure('amount', args[0]);
  return result;
}
