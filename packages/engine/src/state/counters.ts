import type { KeywordAbility } from '../cards/ability';
import type { EnginePermanent } from './types';

/** A generated "for as long as" effect cannot restart after its duration ends. */
export function expireCounterBoundAttackRestrictions(permanent: EnginePermanent): void {
  if (permanent.cantAttackPlayerWhileCounter === undefined) return;
  const remaining = permanent.cantAttackPlayerWhileCounter.filter((restriction) =>
    counterCount(permanent.counters, restriction.counter) > 0);
  if (remaining.length) permanent.cantAttackPlayerWhileCounter = remaining;
  else delete permanent.cantAttackPlayerWhileCounter;
}

/** Counter names are data keys; inherited object properties are never counters. */
export function counterCount(counters: Readonly<Record<string, number>>, name: string): number {
  return Object.hasOwn(counters, name) ? counters[name]! : 0;
}

/** Keyword names as stored in the engine's layer-six characteristics. */
export const KEYWORD_COUNTERS: Readonly<Record<string, KeywordAbility>> = {
  flying: 'flying', 'first strike': 'first strike', 'double strike': 'double strike',
  deathtouch: 'deathtouch', haste: 'haste', hexproof: 'hexproof',
  indestructible: 'indestructible', lifelink: 'lifelink', menace: 'menace', reach: 'reach',
  trample: 'trample', vigilance: 'vigilance',
};

/** Define an owned numeric value even for names such as __proto__. */
export function setCounterCount(
  counters: Record<string, number>,
  name: string,
  count: number,
): void {
  Object.defineProperty(counters, name, {
    value: count,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
