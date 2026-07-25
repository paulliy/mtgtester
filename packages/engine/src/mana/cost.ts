/**
 * Mana cost parsing and payment (brief §5 — "Mana pool, costs, legality of payment" is
 * engine-owned). Phase 2 models the symbols that cover the fixture decks and the vast
 * majority of real cards: generic {N}, the five colors, and colorless {C}.
 *
 * {X}, hybrid ({W/U}, {2/W}), Phyrexian ({G/P}) and snow ({S}) costs are NOT modeled yet —
 * `parseManaCost` reports them as unsupported so the card interpreter can mark the card
 * unmodeled and the engine can halt loudly instead of mispaying (brief §6.3).
 */

import type { Color, ManaCostString, ManaPool } from '@mtg/shared';
import { ALL_COLORS } from '@mtg/shared';
// Type-only, so this does not close a runtime cycle with `cards/ability.ts` (which imports
// `ParsedManaCost` from here).
import type { AbilityCost } from '../cards/ability';

/** A parsed, payable mana cost: generic amount plus per-symbol colored/colorless pips. */
export interface ParsedManaCost {
  generic: number;
  /** Colored pips, e.g. {G}{G} → { G: 2 }. */
  colored: Record<Color, number>;
  /** Colorless {C} pips — payable ONLY with colorless mana. */
  colorless: number;
}

export interface ManaCostParseResult {
  cost: ParsedManaCost | null;
  /** Symbols we cannot model yet ({X}, hybrid, Phyrexian, …); non-empty ⇒ cost is null. */
  unsupportedSymbols: string[];
}

export function emptyCost(): ParsedManaCost {
  return { generic: 0, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 };
}

export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

const SYMBOL_RE = /\{([^}]+)\}/g;

/** Parse an oracle mana cost string. `null`/empty string parses as a zero cost. */
export function parseManaCost(cost: ManaCostString | null): ManaCostParseResult {
  const parsed = emptyCost();
  const unsupported: string[] = [];
  if (cost !== null && cost !== '') {
    for (const match of cost.matchAll(SYMBOL_RE)) {
      const sym = match[1] as string;
      if (/^\d+$/.test(sym)) {
        parsed.generic += Number(sym);
      } else if ((ALL_COLORS as readonly string[]).includes(sym)) {
        parsed.colored[sym as Color] += 1;
      } else if (sym === 'C') {
        parsed.colorless += 1;
      } else {
        unsupported.push(`{${sym}}`);
      }
    }
  }
  return unsupported.length > 0
    ? { cost: null, unsupportedSymbols: unsupported }
    : { cost: parsed, unsupportedSymbols: [] };
}

/** `cost` plus `extraGeneric` (commander tax is {2} × prior casts — brief §5.7). */
export function addGeneric(cost: ParsedManaCost, extraGeneric: number): ParsedManaCost {
  return { ...cost, colored: { ...cost.colored }, generic: cost.generic + extraGeneric };
}

export function totalPips(cost: ParsedManaCost): number {
  return cost.generic + cost.colorless + ALL_COLORS.reduce((sum, c) => sum + cost.colored[c], 0);
}

/**
 * One unit of mana a source can produce when its mana ability is activated.
 * A basic Forest is `{ produces: ['G'] }`; a hypothetical dual would list both colors.
 * Phase 2 sources each produce a fixed number of single-choice units (Sol Ring produces
 * two `['C']` units); multi-choice production is supported by the solver already.
 */
export type ManaUnit = readonly (Color | 'C')[];

/**
 * An activatable mana source — a permanent whose mana ability can be paid for right now.
 * Availability (untapped? not summoning-sick?) is decided by `manaSourcesFor` before the
 * source is offered, so the solver never has to know what the ability costs.
 */
export interface ManaSource {
  /** Stable card id of the permanent to activate. */
  cardId: string;
  /** The units of mana produced when activated, each a choice among symbols. */
  units: ManaUnit[];
  /**
   * What activating it costs. The solver ignores this — availability was already decided — but
   * the caller applying the plan needs it, because "tap it" is not the only way to pay.
   */
  costs: readonly AbilityCost[];
}

export interface PaymentPlan {
  /**
   * Card ids of the sources to activate, in a deterministic order. Named for the {T} cost
   * every Phase 2 source had; a source with a different cost (Reckless Barbarian's "sacrifice
   * this creature") appears here too, and the caller pays whatever that source's cost is.
   */
  tapCardIds: string[];
  /** Mana drawn from the floating pool, by symbol. */
  fromPool: ManaPool;
  /**
   * Mana added to the pool by tapping `tapCardIds` — the SPECIFIC symbol chosen for each
   * produced unit (for multi-symbol sources, the choice that pays the cost). Callers must
   * add exactly this to the pool; re-deriving it from a source's first symbol mispays a
   * multi-color source (e.g. a {W}-or-{U} land used to pay {U}).
   */
  produced: ManaPool;
}

/**
 * Decide whether `cost` can be paid from the floating `pool` plus some subset of `sources`,
 * and if so return a deterministic plan (which sources to tap, what to take from the pool).
 *
 * The engine auto-pays costs: which lands to tap is engine-chosen, not an AI decision
 * (recorded as a Phase 2 scope decision — the strategic content of tap choices is
 * negligible compared to the API cost of asking). The solver is exact: it backtracks over
 * per-unit symbol choices, so multi-color sources never cause a false "cannot pay".
 *
 * Deterministic given identical inputs: sources are considered in the order supplied
 * (callers supply battlefield order), pool mana is preferred over tapping.
 */
export function planPayment(
  cost: ParsedManaCost,
  pool: ManaPool,
  sources: ManaSource[],
): PaymentPlan | null {
  // Work on a mutable remaining-cost copy. Strategy: satisfy colored + {C} pips first
  // (they are the constrained ones), then generic from whatever remains.
  const remaining: ParsedManaCost = {
    generic: cost.generic,
    colored: { ...cost.colored },
    colorless: cost.colorless,
  };
  const poolLeft: ManaPool = { ...pool };
  const fromPool = emptyPool();

  // 1. Pay what we can from the floating pool: colored pips, then {C}, then generic
  //    (generic prefers colorless first to keep colors free — still exact because pool
  //    mana is strictly more flexible than untapped sources are).
  for (const c of ALL_COLORS) {
    const take = Math.min(remaining.colored[c], poolLeft[c]);
    remaining.colored[c] -= take;
    poolLeft[c] -= take;
    fromPool[c] += take;
  }
  {
    const take = Math.min(remaining.colorless, poolLeft.C);
    remaining.colorless -= take;
    poolLeft.C -= take;
    fromPool.C += take;
  }
  for (const sym of ['C', ...ALL_COLORS] as const) {
    if (remaining.generic === 0) break;
    const take = Math.min(remaining.generic, poolLeft[sym]);
    remaining.generic -= take;
    poolLeft[sym] -= take;
    fromPool[sym] += take;
  }

  // 2. Cover the rest by tapping sources. Flatten each source's units; a source is
  //    all-or-nothing (tapping produces all its units; surplus floats and is then
  //    drained at end of step, which is fine).
  const need = remaining;
  if (totalPips(need) === 0) return { tapCardIds: [], fromPool, produced: emptyPool() };

  // Fast path: every unit of every source is single-choice (true for all Phase 2
  // sources — basics, Sol Ring-alikes). Payment is then plain arithmetic: exact-color
  // sources for colored pips, {C} sources for colorless pips, anything for generic.
  // This avoids the backtracking search, which degenerates on unpayable costs with many
  // interchangeable lands.
  if (sources.every((s) => s.units.every((u) => u.length === 1))) {
    return planSingleChoice(need, sources, fromPool);
  }

  // Backtracking over sources: for each source decide tap / don't tap; for each unit of
  // a tapped source decide which symbol it produces and which pip it covers (or floats).
  // Source counts are small (≤ dozens of lands), and we prune on total production. The
  // `produced` accumulator records the symbol actually chosen for each unit of every tapped
  // source (increments are undone on backtrack), so callers add exactly what was chosen.
  const chosen: string[] = [];
  const produced = emptyPool();

  const solve = (srcIdx: number, need2: ParsedManaCost): boolean => {
    if (totalPips(need2) === 0) return true;
    if (srcIdx >= sources.length) return false;
    // Prune: remaining sources cannot produce enough units.
    let unitsLeft = 0;
    for (let i = srcIdx; i < sources.length; i++)
      unitsLeft += (sources[i] as ManaSource).units.length;
    if (unitsLeft < totalPips(need2)) return false;

    const src = sources[srcIdx] as ManaSource;

    // Option A: tap this source. Assign each unit to a pip (or let it float). A tapped
    // source produces ALL its units, so each unit adds a symbol to `produced`.
    const assignUnits = (unitIdx: number, needNow: ParsedManaCost): boolean => {
      if (unitIdx >= src.units.length) {
        return solve(srcIdx + 1, needNow);
      }
      const unit = src.units[unitIdx] as ManaUnit;
      for (const sym of unit) {
        // Cover a colored pip / a {C} pip / a generic pip with this symbol.
        if (sym !== 'C' && needNow.colored[sym] > 0) {
          const next = { ...needNow, colored: { ...needNow.colored } };
          next.colored[sym] -= 1;
          produced[sym] += 1;
          if (assignUnits(unitIdx + 1, next)) return true;
          produced[sym] -= 1;
        }
        if (sym === 'C' && needNow.colorless > 0) {
          const next = { ...needNow, colored: { ...needNow.colored } };
          next.colorless -= 1;
          produced.C += 1;
          if (assignUnits(unitIdx + 1, next)) return true;
          produced.C -= 1;
        }
        if (needNow.generic > 0) {
          const next = { ...needNow, colored: { ...needNow.colored } };
          next.generic -= 1;
          produced[sym] += 1;
          if (assignUnits(unitIdx + 1, next)) return true;
          produced[sym] -= 1;
        }
      }
      // Let this unit float (produce surplus): it still yields mana — count its first
      // symbol so `produced` matches what tapping actually adds to the pool.
      const floatSym = unit[0] as Color | 'C';
      produced[floatSym] += 1;
      if (assignUnits(unitIdx + 1, needNow)) return true;
      produced[floatSym] -= 1;
      return false;
    };

    chosen.push(src.cardId);
    if (assignUnits(0, need2)) return true;
    chosen.pop();

    // Option B: skip this source.
    return solve(srcIdx + 1, need2);
  };

  if (!solve(0, need)) return null;
  return { tapCardIds: chosen, fromPool, produced };
}

/**
 * Exact plan when every unit is single-choice (all Phase 2 sources). Greedy with credit
 * tracking: tapping a source credits ALL its production; surplus from covering one pip
 * counts toward the others and toward generic. Exact for sources whose units are all the
 * same symbol (basics, {C}{C} rocks — the only kind the Phase 2 interpreter emits).
 */
function planSingleChoice(
  need: ParsedManaCost,
  sources: ManaSource[],
  fromPool: ManaPool,
): PaymentPlan | null {
  interface Prod {
    source: ManaSource;
    counts: Record<Color | 'C', number>;
    total: number;
  }
  const prods: Prod[] = sources.map((source) => {
    const counts: Record<Color | 'C', number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    for (const unit of source.units) counts[unit[0] as Color | 'C'] += 1;
    return { source, counts, total: source.units.length };
  });

  const tapped = new Set<Prod>();
  const credit: Record<Color | 'C', number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const tap = (p: Prod): void => {
    tapped.add(p);
    for (const sym of ['W', 'U', 'B', 'R', 'G', 'C'] as const) credit[sym] += p.counts[sym];
  };

  // Colored pips, then {C} pips: consume credit, tapping more sources as needed —
  // smallest producers of the needed symbol first, to keep flexible sources free.
  const cover = (sym: Color | 'C', pips: number): boolean => {
    let left = pips;
    const consume = (): void => {
      const take = Math.min(left, credit[sym]);
      credit[sym] -= take;
      left -= take;
    };
    consume();
    while (left > 0) {
      const pick = prods
        .filter((p) => !tapped.has(p) && p.counts[sym] > 0)
        .sort((a, b) => a.total - b.total)[0];
      if (pick === undefined) return false;
      tap(pick);
      consume();
    }
    return true;
  };
  for (const c of ALL_COLORS) {
    if (!cover(c, need.colored[c])) return null;
  }
  if (!cover('C', need.colorless)) return null;

  // Generic: leftover credit of any symbol first, then untapped sources in battlefield
  // order (deterministic).
  let genericLeft = need.generic;
  for (const sym of ['C', 'W', 'U', 'B', 'R', 'G'] as const) {
    const take = Math.min(genericLeft, credit[sym]);
    credit[sym] -= take;
    genericLeft -= take;
  }
  for (const p of prods) {
    if (genericLeft <= 0) break;
    if (tapped.has(p)) continue;
    tap(p);
    genericLeft -= Math.min(genericLeft, p.total);
  }
  if (genericLeft > 0) return null;

  // Preserve the caller-supplied (battlefield) order for determinism. A tapped source
  // produces all its units; `produced` is the sum of every tapped source's output.
  const tappedProds = prods.filter((p) => tapped.has(p));
  const produced = emptyPool();
  for (const p of tappedProds) {
    for (const sym of ['W', 'U', 'B', 'R', 'G', 'C'] as const) produced[sym] += p.counts[sym];
  }
  const tapCardIds = tappedProds.map((p) => p.source.cardId);
  return { tapCardIds, fromPool, produced };
}

/** True iff `cost` is payable from `pool` + `sources`. */
export function canPay(cost: ParsedManaCost, pool: ManaPool, sources: ManaSource[]): boolean {
  return planPayment(cost, pool, sources) !== null;
}
