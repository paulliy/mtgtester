/**
 * Condition phrases for the card grammar (ADR 0038): intervening-if clauses on triggers
 * (CR 603.4), activation restrictions ("Activate only if …"), and the "unless …" of a land that
 * enters tapped. Each parser returns a `Condition` or null, and null leaves the card unmodeled.
 */

import type { OracleCard } from '@mtg/shared';
import { LAND_SUBTYPES, parseAmount } from './words';
import { parseSubject, parseTriggerSubject } from './subject';
import type { Condition } from '../condition';
import { countPermanents } from '../condition';
import type { Selector } from '../selector';
import type { Value } from '../value';
import { OTHER, allOf, anyOf, ofSubtype, ofSupertype, ofType } from '../selector';
import { noteSlotFailure } from './diagnostics';

/** The intervening-if clause (CR 603.4): "…, if you control a Dragon, draw a card". */
export const INTERVENING_IF_RE = /^if (.+?), (.+)$/;

/**
 * A condition clause as rules text writes it — "you control a creature with power 4 or
 * greater". Reuses `parseTriggerSubject`, so anything expressible as a trigger subject is
 * automatically countable here too.
 */
function parseConditionClauseUntraced(clause: string, card: OracleCard): Condition | null {
  if (clause === 'it was kicked' || clause === 'this spell was kicked') {
    return { kind: 'wasKicked' };
  }
  // "When this creature enters, if you cast it, …" (Shard of the Nightbringer): read from the
  // permanent's cast record, so reanimating or flickering it does not count.
  if (clause === 'you cast it') return { kind: 'sourceWasCast' };
  if (clause === 'it escaped' || clause === '~ escaped') {
    return { kind: 'escaped' };
  }
  if (
    clause === 'a creature or planeswalker an opponent controlled was dealt excess damage this turn'
  ) {
    return { kind: 'excessDamageDealtTo', scope: 'opponents' };
  }
  // "if you've cast a noncreature spell this turn" — the shared intervening-if of the Fantastic
  // Four cycle. A tally kept at cast time, not a board read, so it survives the spell resolving.
  {
    const cast = clause.match(/^you've cast (?:a|an) (noncreature )?spell this turn$/);
    if (cast !== null) {
      return {
        kind: 'castSpellThisTurn',
        category: cast[1] === undefined ? 'any' : 'noncreature',
        cmp: '>=',
        n: 1,
      };
    }
  }
  // "if there are thirteen or more creatures on the battlefield" (Blasphemous Edict) — every
  // player's permanents count.
  {
    const total = clause.match(/^there are (\w+) or more (.+) on the battlefield$/);
    if (total !== null) {
      const n = parseAmount(total[1] as string);
      const selector = parseSubject(total[2] as string, card);
      if (n === null || selector === null) return null;
      return countPermanents(selector, 'all', '>=', n);
    }
  }
  // "if you control four or more creatures" — a threshold rather than the bare "you control a
  // creature" below, which is the same condition with an implied n of 1. The subject is stripped
  // of its count before `parseTriggerSubject` sees it, so it reads the same singular grammar.
  {
    const counted = clause.match(/^you control (\w+) or more (.+)$/);
    if (counted !== null) {
      const n = parseAmount(counted[1] as string);
      const selector = parseSubject(counted[2] as string, card);
      if (n === null || selector === null) return null;
      return countPermanents(selector, 'you', '>=', n);
    }
  }
  // "if it has no ice counters on it" / "if ~ has three or more charge counters on it" — the
  // ability's own source, not a selector match.
  {
    const counters = clause.match(
      /^(?:it|~|this (?:artifact|creature|enchantment|land|permanent)) has (no|\w+ or more|\w+ or fewer) ([a-z]+) counters? on it$/,
    );
    if (counters !== null) {
      const quantifier = counters[1] as string;
      const counter = counters[2] as string;
      if (quantifier === 'no') return { kind: 'sourceHasCounters', counter, cmp: '<=', n: 0 };
      const [word, , direction] = quantifier.split(' ');
      const n = parseAmount(word as string);
      if (n === null) return null;
      return { kind: 'sourceHasCounters', counter, cmp: direction === 'more' ? '>=' : '<=', n };
    }
  }
  // "if you have seven or more cards in your graveyard" (Search for Azcanta).
  {
    const graveyard = clause.match(/^you have (\w+) or more cards in your graveyard$/);
    if (graveyard !== null) {
      const n = parseAmount(graveyard[1] as string);
      if (n === null) return null;
      return { kind: 'cardsInYourGraveyard', cmp: '>=', n };
    }
  }
  const m = clause.match(/^you control (.+)$/);
  if (m === null) return null;
  const selector = parseTriggerSubject(m[1] as string, card);
  if (selector === null) return null;
  return countPermanents(selector, 'you', '>=', 1);
}

/**
 * The condition of an "Activate only if …" restriction (CR 602.5b), lowercased with no trailing
 * period. Returns null for any phrasing it does not know, so the ability stays unmodeled rather
 * than becoming activatable at times the card forbids.
 */
function parseActivationConditionUntraced(text: string, card: OracleCard): Condition | null {
  const sameName = text.match(/^you control (\w+) or more lands with the same name$/);
  if (sameName !== null) {
    const n = parseAmount(sameName[1] as string);
    return n === null ? null : { kind: 'controlsLandsWithSameName', n };
  }
  const opponentMore = text.match(/^an opponent controls more (.+) than you$/);
  if (opponentMore !== null) {
    const selector = parseSubject(opponentMore[1] as string, card);
    return selector === null ? null : { kind: 'opponentControlsMore', selector };
  }
  if (text === 'you created a token this turn') return { kind: 'createdTokenThisTurn' };
  const counted = text.match(/^you control (\w+) or more (.+)$/);
  if (counted !== null) {
    const n = parseAmount(counted[1] as string);
    const selector = parseSubject(counted[2] as string, card);
    return n === null || selector === null ? null : countPermanents(selector, 'you', '>=', n);
  }
  return null;
}

/**
 * The "unless …" clause of a conditional-enters-tapped land → a `Condition`. Returns null for
 * anything unlisted, leaving the card unmodeled rather than guessing a predicate — a land that
 * silently entered untapped would be a real (if small) misplay every game.
 */
function parseEntersUnlessClauseUntraced(clause: string, card: OracleCard): Condition | null {
  // "a player has 13 or less life" (Razortrap Gorge and the other Duskmourn lands).
  {
    const m = clause.match(/^a player has (\w+) or less life$/);
    const n = m === null ? null : parseAmount(m[1] as string);
    if (n !== null) return { kind: 'anyPlayerLifeAtMost', n };
  }
  // "you have two or more opponents"
  {
    const m = clause.match(/^you have (\w+) or (more|fewer) opponents$/);
    if (m) {
      const n = parseAmount(m[1] as string);
      if (n === null) return null;
      return { kind: 'opponentCount', cmp: m[2] === 'more' ? '>=' : '<=', n };
    }
  }
  // "you control a Mountain or a Forest" — a subtype list, any of which satisfies it.
  {
    const m = clause.match(/^you control (a|an) (.+)$/);
    if (m) {
      const nouns = (m[2] as string).split(/,? or (?:a |an )?/).map((s) => s.trim());
      const selectors: Selector[] = [];
      for (const noun of nouns) {
        // Printed capitalized on the card ("a Mountain"), but `clause` is lowercased; match
        // against the land subtypes this card itself can check for.
        const subtype = LAND_SUBTYPES.find((s) => s.toLowerCase() === noun);
        if (subtype === undefined) return null;
        selectors.push(ofSubtype(subtype));
      }
      if (selectors.length === 0) return null;
      return countPermanents(
        selectors.length === 1 ? (selectors[0] as Selector) : anyOf(...selectors),
        'you',
        '>=',
        1,
      );
    }
  }
  // "you control two or more other lands" / "… two or fewer other lands"
  // "you control two or more basic lands"
  // "your opponents control eight or more lands"
  {
    const m = clause.match(
      /^(you|your opponents) controls? (\w+) or (more|fewer) (other |basic )?lands$/,
    );
    if (m) {
      const n = parseAmount(m[2] as string);
      if (n === null) return null;
      const parts: Selector[] = [ofType('Land')];
      if ((m[4] ?? '').trim() === 'other') parts.push(OTHER);
      if ((m[4] ?? '').trim() === 'basic') parts.push(ofSupertype('Basic'));
      return countPermanents(
        parts.length === 1 ? (parts[0] as Selector) : allOf(...parts),
        m[1] === 'you' ? 'you' : 'opponents',
        m[3] === 'more' ? '>=' : '<=',
        n,
      );
    }
  }
  void card;
  return null;
}

const atLeast = (left: Value, n: number): Condition => ({
  kind: 'compareValues',
  left,
  cmp: '>=',
  right: { kind: 'const', n },
});

/**
 * Turn-history, life and board conditions (EDHREC plan Phase 4 step 3) over `Value`s and
 * `Condition`s the engine already evaluates. Tried only once the clause parser failed.
 */
function parseMoreConditions(clause: string, card: OracleCard): Condition | null {
  if (clause === 'a creature died this turn') return atLeast({ kind: 'creaturesDiedThisTurn' }, 1);
  if (clause === 'an opponent lost life this turn')
    return atLeast({ kind: 'opponentsLostLifeThisTurn' }, 1);
  if (clause === 'it was cast') return { kind: 'sourceWasCast' };
  if (clause === 'you control your commander') return { kind: 'controlsYourCommander' };
  if (/^(?:~|this (?:artifact|creature|enchantment|land|permanent)) is untapped$/.test(clause))
    return { kind: 'isUntapped' };
  if (clause === 'an opponent controls more lands than you')
    return { kind: 'opponentControlsMore', selector: ofType('Land') };
  {
    const m = clause.match(/^you have (\w+) or more life$/);
    const n = m === null ? null : parseAmount(m[1] as string);
    if (n !== null) return atLeast({ kind: 'lifeTotal', scope: 'you' }, n);
  }
  {
    const m = clause.match(/^there are (\w+) or more cards in your graveyard$/);
    const n = m === null ? null : parseAmount(m[1] as string);
    if (n !== null) return { kind: 'cardsInYourGraveyard', cmp: '>=', n };
  }
  {
    const m = clause.match(/^there are (\w+) or more card types among cards in your graveyard$/);
    const n = m === null ? null : parseAmount(m[1] as string);
    if (n !== null) return atLeast({ kind: 'cardTypesInYourGraveyard' }, n);
  }
  {
    const m = clause.match(/^creatures you control have total power (\w+) or greater$/);
    const n = m === null ? null : parseAmount(m[1] as string);
    if (n !== null) return { kind: 'totalCreaturePower', scope: 'you', cmp: '>=', n };
  }
  // "you control a legendary creature" / "you control no Snakes" / "you control ten or more
  // Treasures" / "no creatures are on the battlefield".
  {
    const none = clause.match(/^you control no (.+)$/);
    if (none !== null) {
      const selector = parseSubject(none[1] as string, card);
      if (selector !== null) return countPermanents(selector, 'you', '<=', 0);
    }
    if (clause === 'no creatures are on the battlefield')
      return countPermanents(ofType('Creature'), 'all', '<=', 0);
    const some = clause.match(/^you control (an?|\w+ or more) (.+)$/);
    if (some !== null) {
      const word = (some[1] as string).replace(/ or more$/, '');
      const n = word === 'a' || word === 'an' ? 1 : parseAmount(word);
      const selector = parseSubject(some[2] as string, card);
      if (n !== null && selector !== null) return countPermanents(selector, 'you', '>=', n);
    }
  }
  return null;
}

/** `parseConditionClauseUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseConditionClause(
  ...args: Parameters<typeof parseConditionClauseUntraced>
): ReturnType<typeof parseConditionClauseUntraced> {
  const result = parseConditionClauseUntraced(...args) ?? parseMoreConditions(...args);
  if (result === null) noteSlotFailure('condition', args[0]);
  return result;
}

/** `parseActivationConditionUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseActivationCondition(
  ...args: Parameters<typeof parseActivationConditionUntraced>
): ReturnType<typeof parseActivationConditionUntraced> {
  const result = parseActivationConditionUntraced(...args);
  if (result === null) noteSlotFailure('condition', args[0]);
  return result;
}

/** `parseEntersUnlessClauseUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseEntersUnlessClause(
  ...args: Parameters<typeof parseEntersUnlessClauseUntraced>
): ReturnType<typeof parseEntersUnlessClauseUntraced> {
  const result = parseEntersUnlessClauseUntraced(...args);
  if (result === null) noteSlotFailure('condition', args[0]);
  return result;
}
