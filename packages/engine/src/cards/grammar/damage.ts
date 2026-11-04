/**
 * Damage clauses for the effect grammar (ADR 0038 decision 3, EDHREC plan Phase 4 batch 4):
 * "<source> deals <amount> damage to <recipient>", with the source "~", "this <type>" or "it",
 * any count phrase as the amount ("3", "X", "that much"), and the recipient a target phrase,
 * "each opponent", "each player", "you" or the event's player.
 *
 * Tried only after the sentence-level parse fails. A combination with no existing op returns
 * null (ADR 0038 decision 4).
 */

import type { OracleCard } from '@mtg/shared';
import type { Effect, EffectRef } from '../ability';
import type { Value } from '../value';
import { parseCountPhrase } from './amount';
import type { SlotAllocator } from './subject';
import { parseTargetClause } from './subject';
import { knowsX } from './player-verb';

export interface DamageOptions {
  triggerObject?: boolean;
  eventPlayer?: boolean;
  thatMany?: Value;
  xBound?: boolean;
}

const isSpell = (card: OracleCard): boolean =>
  card.types.includes('Instant') || card.types.includes('Sorcery');

/**
 * Who "it" is. Inside a trigger watching another object it is that object (its last-known
 * facts, CR 608.2h). On a permanent's own ability it is the permanent. A spell's "it" refers back
 * to something an earlier sentence named, which this clause cannot see.
 */
function parseDamageSource(
  phrase: string,
  card: OracleCard,
  opts: DamageOptions,
): { source?: EffectRef } | null {
  if (
    phrase === '~' ||
    /^this (?:creature|artifact|enchantment|land|permanent|vehicle)$/.test(phrase)
  )
    return isSpell(card) && phrase !== '~' ? null : {};
  if (phrase !== 'it') return null;
  if (opts.triggerObject === true) return { source: 'triggerObject' };
  return isSpell(card) ? null : {};
}

export function parseDamageSentence(
  s: string,
  alloc: SlotAllocator,
  card: OracleCard,
  opts: DamageOptions,
): Effect[] | null {
  const m = s.match(
    /^(~|it|this (?:creature|artifact|enchantment|land|permanent|vehicle)) deals (\S+|that much) damage to (.+)$/,
  );
  if (m === null) return null;
  const source = parseDamageSource(m[1] as string, card, opts);
  if (source === null) return null;
  const word = m[2] as string;
  if (word === 'x' && !knowsX(card, opts)) return null;
  const amount = parseCountPhrase(word, opts.thatMany);
  if (amount === null) return null;
  const recipient = m[3] as string;
  const one = (target: EffectRef): Effect[] => [{ op: 'dealDamage', target, amount, ...source }];
  switch (recipient) {
    case 'any target':
      return one(alloc('anyTarget'));
    case 'each opponent':
      return source.source === undefined ? [{ op: 'eachOpponentDamage', amount }] : null;
    case 'each player':
      return [{ op: 'damageEachPlayer', amount, ...source }];
    case 'you':
      return source.source === undefined && amount.kind === 'const'
        ? [{ op: 'damageController', amount: amount.n }]
        : null;
    case 'that player':
      return opts.eventPlayer === true ? one('eventPlayer') : null;
    case 'target opponent':
      return one(alloc('player', undefined, 'opponent'));
    case 'target player':
      return one(alloc('player'));
    case 'target player or planeswalker':
      return one(alloc('playerOrPlaneswalker'));
    default: {
      const t = recipient.match(/^target (.+)$/);
      const clause = t === null ? null : parseTargetClause(t[1] as string);
      if (clause === null) return null;
      return one(alloc(clause.kind, clause.filter, clause.controller));
    }
  }
}
