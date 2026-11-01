/**
 * Which mana sources auto-pay should reach for first.
 *
 * `planPayment` taps sources in the order it is given them, so the order decides which lands are
 * still untapped afterwards. Battlefield order alone taps an Island for the generic part of
 * {1}{B} while three Swamps sit there and a {1}{U} spell waits in hand. This module ranks sources
 * by how much the player's OTHER costs (spells in hand, commanders, activated abilities) still
 * want what each source makes, so the cheapest source to lose goes first and a source is only
 * spent on a payment that leaves another cost short when no other source can do the job.
 *
 * The ranking is per color and per source, so it does not care how many colors a deck plays:
 * every symbol (W, U, B, R, G and colorless) is weighed the same way. It never changes WHETHER a
 * payment is possible (the solver stays exact over any order), only which legal payment is the
 * first one found.
 */

import type { Color } from '@mtg/shared';
import { ALL_COLORS } from '@mtg/shared';
import type { ManaSource, ParsedManaCost } from './cost';

type ManaSymbol = Color | 'C';

const SYMBOLS: readonly ManaSymbol[] = [...ALL_COLORS, 'C'];

/**
 * A small bonus per symbol a source can make, so that with no demand to tell them apart a basic
 * is spent before a dual. Far below one pip of real demand, so it only breaks ties.
 */
const FLEXIBILITY = 1e-3;

/**
 * The most pips of each symbol any one of `costs` asks for. One cost at a time rather than the
 * sum: the question is whether the next spell can still be cast, and a hand of three {U} spells
 * needs one Island each turn, not three at once. A hybrid pip counts towards each of its colors in
 * proportion, since any one of them pays it; a Phyrexian pip counts in full, because paying it
 * with mana instead of life is the better outcome.
 */
export function manaDemand(costs: readonly ParsedManaCost[]): Record<ManaSymbol, number> {
  const demand: Record<ManaSymbol, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const cost of costs) {
    const pips: Record<ManaSymbol, number> = { ...cost.colored, C: cost.colorless };
    for (const pair of cost.hybrid ?? []) for (const color of pair) pips[color] += 1 / pair.length;
    for (const color of cost.phyrexian ?? []) pips[color] += 1;
    for (const symbol of SYMBOLS) demand[symbol] = Math.max(demand[symbol], pips[symbol]);
  }
  return demand;
}

/**
 * How much each permanent (by card id) is worth keeping untapped, given what `demand` asks for.
 *
 * A symbol's weight is its demand divided by how many permanents can make it: one Island against
 * a {U} spell is precious, one of six Islands is not. A permanent's value sums the weights of the
 * symbols it can make, so a dual counts for both colors it could supply.
 */
export function keepValues(
  sources: readonly ManaSource[],
  demand: Record<ManaSymbol, number>,
): Map<string, number> {
  const produces = new Map<string, Set<ManaSymbol>>();
  for (const source of sources) {
    const symbols = produces.get(source.cardId) ?? new Set<ManaSymbol>();
    for (const unit of source.units) for (const symbol of unit) symbols.add(symbol);
    produces.set(source.cardId, symbols);
  }
  const supply: Record<ManaSymbol, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const symbols of produces.values()) for (const symbol of symbols) supply[symbol]++;
  const values = new Map<string, number>();
  for (const [cardId, symbols] of produces) {
    let value = 0;
    for (const symbol of symbols) value += demand[symbol] / supply[symbol] + FLEXIBILITY;
    values.set(cardId, value);
  }
  return values;
}

/**
 * `sources` reordered so that, within each tier, the permanents least worth keeping come first.
 *
 * `tierOf` is the caller's existing preference (lands before artifacts before creatures), which
 * still wins: this only reorders within a tier. The sort is stable, and a permanent's sources all
 * share one key, so they stay together and keep their order, and equal permanents keep battlefield
 * order. `demand` is only read when some tier has permanents that make different symbols, since
 * otherwise no order is better than another.
 */
export function orderByKeepValue(
  sources: readonly ManaSource[],
  tierOf: (cardId: string) => number,
  demand: () => readonly ParsedManaCost[],
): ManaSource[] {
  const signatures = new Map<string, Set<ManaSymbol>>();
  for (const source of sources) {
    const symbols = signatures.get(source.cardId) ?? new Set<ManaSymbol>();
    for (const unit of source.units) for (const symbol of unit) symbols.add(symbol);
    signatures.set(source.cardId, symbols);
  }
  const firstByTier = new Map<number, string>();
  let differ = false;
  for (const [cardId, symbols] of signatures) {
    const key = [...symbols].sort().join('');
    const tier = tierOf(cardId);
    const seen = firstByTier.get(tier);
    if (seen === undefined) firstByTier.set(tier, key);
    else if (seen !== key) differ = true;
  }
  if (!differ) return [...sources];
  const values = keepValues(sources, manaDemand(demand()));
  return [...sources].sort(
    (a, b) =>
      tierOf(a.cardId) - tierOf(b.cardId) ||
      (values.get(a.cardId) ?? 0) - (values.get(b.cardId) ?? 0),
  );
}
