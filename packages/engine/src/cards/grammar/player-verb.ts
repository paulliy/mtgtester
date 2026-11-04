/**
 * Player-scoped verb clauses for the effect grammar (ADR 0038 decision 3, EDHREC plan Phase 4
 * steps 1 and 5): "<player> <verb> <amount> <unit>", where the player is "you", "target
 * player", "target opponent", "each player", "each opponent" or the event's player ("that
 * player", "they"), the verb is gain or lose life, draw, discard or mill, and the amount is any
 * count phrase ("two", "X", "that much"). Two clauses joined by "and" share the first subject
 * when the second has none ("target player draws two cards and loses 2 life").
 *
 * Tried only after the sentence-level parse fails, so no sentence that already parses changes.
 * Every combination either maps onto an existing op or returns null: the grammar emits existing
 * IR only (ADR 0038 decision 4).
 */

import type { OracleCard } from '@mtg/shared';
import type { Effect, EffectRef } from '../ability';
import type { Value } from '../value';
import { parseCountPhrase } from './amount';
import type { SlotAllocator } from './subject';

type PlayerScope =
  { kind: 'you' } | { kind: 'each'; scope: 'all' | 'opponents' } | { kind: 'one'; ref: EffectRef };

export interface PlayerVerbOptions {
  thatMany?: Value;
  /** The trigger's event names a player, so "that player" and "they" refer to them. */
  eventPlayer?: boolean;
  /** A surrounding "where X is …" defines X (`parseAmountForm`). */
  xBound?: boolean;
}

/**
 * Whether a bare "X" in this clause is a value the grammar knows: one a surrounding "where X is"
 * defines, or the announced X of an instant or sorcery (CR 601.2b). A permanent's X is gone once
 * it has resolved (CR 107.3m reaches only its enters abilities, which do not carry it here), and
 * an ability's own X is announced with that ability, not on the card.
 */
export function knowsX(card: OracleCard, opts: { xBound?: boolean }): boolean {
  return (
    opts.xBound === true ||
    ((card.types.includes('Instant') || card.types.includes('Sorcery')) &&
      (card.manaCost ?? '').includes('{X}'))
  );
}

const SUBJECT_RE =
  /^(you|target player|target opponent|each player|each opponent|that player|they) (.+)$/;

function parseScope(
  phrase: string,
  alloc: SlotAllocator,
  opts: PlayerVerbOptions,
): PlayerScope | null {
  switch (phrase) {
    case 'you':
      return { kind: 'you' };
    case 'each player':
      return { kind: 'each', scope: 'all' };
    case 'each opponent':
      return { kind: 'each', scope: 'opponents' };
    case 'target player':
      return { kind: 'one', ref: alloc('player') };
    case 'target opponent':
      return { kind: 'one', ref: alloc('player', undefined, 'opponent') };
    case 'that player':
    case 'they':
      return opts.eventPlayer === true ? { kind: 'one', ref: 'eventPlayer' } : null;
    default:
      return null;
  }
}

/** "a card", "two cards", "x cards", "that many cards"; "2 life", "that much life". */
function parseQuantity(
  phrase: string,
  unit: 'card' | 'life',
  card: OracleCard,
  opts: PlayerVerbOptions,
): Value | null {
  const m = unit === 'card' ? phrase.match(/^(.+?) cards?$/) : phrase.match(/^(.+?) life$/);
  if (m === null) return null;
  const word = m[1] as string;
  if (unit === 'card' && (word === 'a' || word === 'an')) return { kind: 'const', n: 1 };
  // An X the card does not announce is some other quantity this clause cannot see.
  if (word === 'x' && !knowsX(card, opts)) return null;
  return parseCountPhrase(word, opts.thatMany);
}

const constantOf = (value: Value): number | null => (value.kind === 'const' ? value.n : null);

/** One "<verb> <amount> <unit>" clause for an already-read player scope. */
function parseVerb(
  scope: PlayerScope,
  rest: string,
  card: OracleCard,
  opts: PlayerVerbOptions,
): Effect[] | null {
  const m = rest.match(/^(gains?|loses?|draws?|discards?|mills?) (.+)$/);
  if (m === null) return null;
  const verb = (m[1] as string).replace(/s$/, '');
  const unit = verb === 'gain' || verb === 'lose' ? 'life' : 'card';
  const amount = parseQuantity(m[2] as string, unit, card, opts);
  if (amount === null) return null;
  switch (verb) {
    case 'gain':
      if (scope.kind === 'you') return [{ op: 'gainLife', amount }];
      if (scope.kind === 'each' && scope.scope === 'all')
        return [{ op: 'eachPlayerGainsLife', amount }];
      return null;
    case 'lose':
      if (scope.kind === 'you') return [{ op: 'loseLife', amount }];
      if (scope.kind === 'one') return [{ op: 'loseLifeTarget', target: scope.ref, amount }];
      return scope.scope === 'opponents'
        ? [{ op: 'eachOpponentLosesLife', amount }]
        : [{ op: 'eachPlayerLosesLife', amount }];
    case 'draw':
      if (scope.kind === 'you') return [{ op: 'draw', count: amount }];
      if (scope.kind === 'one') return [{ op: 'drawTarget', target: scope.ref, count: amount }];
      return [{ op: 'eachPlayerDraws', scope: scope.scope, count: amount }];
    case 'discard': {
      if (scope.kind === 'you') {
        const n = constantOf(amount);
        return n === null ? null : [{ op: 'discard', count: n }];
      }
      if (scope.kind === 'one') return [{ op: 'discardTarget', target: scope.ref, count: amount }];
      return [{ op: 'discardEachPlayer', scope: scope.scope, count: amount }];
    }
    case 'mill': {
      if (scope.kind === 'you') return [{ op: 'mill', count: amount }];
      if (scope.kind === 'one') {
        const n = constantOf(amount);
        return n === null ? null : [{ op: 'millTargetPlayer', target: scope.ref, count: n }];
      }
      return [{ op: 'millEachPlayer', scope: scope.scope, count: amount }];
    }
    default:
      return null;
  }
}

/**
 * "<player> <verb> <amount> <unit>[ and [<player>] <verb> <amount> <unit>]". Returns null for
 * anything else. The subject is read (and a target slot allocated) only once the whole clause
 * shape is known to parse.
 */
export function parsePlayerVerbSentence(
  s: string,
  alloc: SlotAllocator,
  card: OracleCard,
  opts: PlayerVerbOptions,
): Effect[] | null {
  const head = s.match(SUBJECT_RE);
  if (head === null) return null;
  const subject = head[1] as string;
  const rest = head[2] as string;
  // Dry-run the clauses against a scratch scope first, so a sentence that does not parse never
  // allocates a target slot.
  const probe: PlayerScope =
    subject === 'you'
      ? { kind: 'you' }
      : subject.startsWith('each')
        ? { kind: 'each', scope: subject === 'each player' ? 'all' : 'opponents' }
        : { kind: 'one', ref: 'eventPlayer' };
  const parts = splitAnd(rest);
  const plan: { subject: string; rest: string }[] = [];
  for (const [index, part] of parts.entries()) {
    const own = index === 0 ? null : part.match(SUBJECT_RE);
    const partSubject = own === null ? subject : (own[1] as string);
    const partRest = own === null ? part : (own[2] as string);
    const partProbe: PlayerScope =
      partSubject === subject
        ? probe
        : partSubject === 'you'
          ? { kind: 'you' }
          : partSubject.startsWith('each')
            ? { kind: 'each', scope: partSubject === 'each player' ? 'all' : 'opponents' }
            : { kind: 'one', ref: 'eventPlayer' };
    if (parseVerb(partProbe, partRest, card, opts) === null) return null;
    // A second targeted subject would be a second target; keep to one per sentence.
    if (index > 0 && own !== null && /^target /.test(partSubject)) return null;
    plan.push({ subject: partSubject, rest: partRest });
  }
  const scopes = new Map<string, PlayerScope>();
  const effects: Effect[] = [];
  for (const step of plan) {
    let scope = scopes.get(step.subject);
    if (scope === undefined) {
      const read = parseScope(step.subject, alloc, opts);
      if (read === null) return null;
      scope = read;
      scopes.set(step.subject, scope);
    }
    const parsed = parseVerb(scope, step.rest, card, opts);
    if (parsed === null) return null;
    effects.push(...parsed);
  }
  return effects;
}

/** Split "draws two cards and loses 2 life" into its clauses (at most two). */
function splitAnd(rest: string): string[] {
  // "draws a card, then discards a card" (Geier Reach Sanitarium): in order, same subject.
  for (const joint of [' and ', ', then ']) {
    const index = rest.indexOf(joint);
    if (index >= 0) return [rest.slice(0, index), rest.slice(index + joint.length)];
  }
  return [rest];
}
