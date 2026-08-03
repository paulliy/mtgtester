/**
 * The engine-side mana pool (ADR 0010, Inc 12; CR 106).
 *
 * Two mana of the same color stopped being interchangeable the moment one of them could carry a
 * spending restriction (CR 106.6), a reflexive spend trigger, or an exemption from the
 * end-of-step drain. So the authoritative pool is a **list of `ManaEntry`**, not the shared
 * `ManaPool`'s per-symbol counts.
 *
 * `PlayerState.manaPool` still exists and is still per-symbol counts — it is the **derived
 * summary** the `PlayerView`, the spectator projection and the web app read, none of which have
 * any use for the distinction. This module is the single place both are mutated, so the summary
 * cannot drift from the entries; `mana-restricted.test.ts` asserts that invariant directly.
 */

import type { Color, ManaPool } from '@mtg/shared';
import { ALL_COLORS } from '@mtg/shared';
import type { ManaEntry } from '../cards/ability';

/** Everything this module needs of a player: the entries, and the summary derived from them. */
export interface ManaPoolHolder {
  manaEntries: ManaEntry[];
  manaPool: ManaPool;
}

export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

/** The flat per-symbol counts implied by `entries`. */
export function summarize(entries: readonly ManaEntry[]): ManaPool {
  const pool = emptyPool();
  for (const entry of entries) pool[entry.symbol] += 1;
  return pool;
}

/** Re-derive the summary. Every mutation below ends here; nothing else writes `manaPool`. */
function resync(holder: ManaPoolHolder): void {
  holder.manaPool = summarize(holder.manaEntries);
}

/** Add produced mana to the pool (CR 106.4). */
export function addMana(holder: ManaPoolHolder, entries: readonly ManaEntry[]): void {
  holder.manaEntries.push(...entries);
  resync(holder);
}

/**
 * Remove exactly the given entries, by identity.
 *
 * By identity and not by value on purpose: two entries can be equal in every field and still be
 * different mana, and the spend trigger has to fire for the one actually consumed.
 */
export function removeMana(holder: ManaPoolHolder, entries: readonly ManaEntry[]): void {
  for (const entry of entries) {
    const i = holder.manaEntries.indexOf(entry);
    if (i < 0) throw new Error('engine bug: spent a mana entry that was not in the pool');
    holder.manaEntries.splice(i, 1);
  }
  resync(holder);
}

/**
 * Empty the pool as a step or phase ends (CR 500.4).
 *
 * Mana marked `persistent` stays — "until end of turn, you don't lose this mana as steps and
 * phases end" (Klauth). Cleanup at end of turn drops it like anything else, which
 * `emptyManaPools(ctx, { includePersistent: true })` expresses.
 */
export function drainPool(holder: ManaPoolHolder, includePersistent: boolean): void {
  holder.manaEntries = includePersistent
    ? []
    : holder.manaEntries.filter((e) => e.persistent === true);
  resync(holder);
}

/**
 * Choose which specific entries pay `cost`, given a pool already known to be able to.
 *
 * Deliberately mirrors the deduction order `payManaCost` used before entries existed — exact
 * colored pips, then hybrid pips, then {C}, then generic (colorless first, then WUBRG) — so the
 * mana actually spent is unchanged for every card that has no restrictions.
 *
 * Within each of those buckets, **restricted mana is spent first**. Restricted mana is strictly
 * less useful than unrestricted mana of the same symbol, so spending it first can never lose a
 * payment the player could otherwise have made, and it is what a human does by reflex. Returns
 * null when the pool cannot cover the cost, which is a caller bug — `planPayment` decided
 * payability already.
 */
export function selectEntriesToSpend(
  entries: readonly ManaEntry[],
  cost: { generic: number; colored: Record<Color, number>; colorless: number; hybrid?: (Color[])[] },
): ManaEntry[] | null {
  const available = [...entries].sort(sortRestrictedFirst);
  const taken: ManaEntry[] = [];

  const take = (n: number, matches: (e: ManaEntry) => boolean): boolean => {
    let left = n;
    for (const entry of available) {
      if (left === 0) break;
      if (taken.includes(entry) || !matches(entry)) continue;
      taken.push(entry);
      left -= 1;
    }
    return left === 0;
  };

  for (const c of ALL_COLORS) {
    if (!take(cost.colored[c], (e) => e.symbol === c)) return null;
  }
  // Each hybrid pip ({U/B}) is covered by one entry of ANY symbol in its tuple — every entry
  // is still spent exactly once (`taken.includes` above/below excludes it from later buckets).
  for (const h of cost.hybrid ?? []) {
    if (!take(1, (e) => (h as string[]).includes(e.symbol))) return null;
  }
  if (!take(cost.colorless, (e) => e.symbol === 'C')) return null;
  // Generic prefers colorless, then WUBRG — the same order the pre-entry code deducted in.
  let generic = cost.generic;
  for (const sym of ['C', ...ALL_COLORS] as const) {
    if (generic === 0) break;
    const before = taken.length;
    take(generic, (e) => e.symbol === sym);
    generic -= taken.length - before;
  }
  return generic === 0 ? taken : null;
}

/** Restricted mana sorts before unrestricted; otherwise the pool's existing order is kept. */
function sortRestrictedFirst(a: ManaEntry, b: ManaEntry): number {
  const rank = (e: ManaEntry): number => (e.restriction === undefined ? 1 : 0);
  return rank(a) - rank(b);
}
