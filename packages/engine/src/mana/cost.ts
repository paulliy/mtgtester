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
import type {
  AbilityCost,
  ManaEntry,
  ManaRestriction,
  ManaSpendTrigger,
} from '../cards/ability';
import { emptyPool, summarize } from './pool';

export { emptyPool } from './pool';

/** A parsed, payable mana cost: generic amount plus per-symbol colored/colorless pips. */
export interface ParsedManaCost {
  generic: number;
  /** Colored pips, e.g. {G}{G} → { G: 2 }. */
  colored: Record<Color, number>;
  /** Colorless {C} pips — payable ONLY with colorless mana. */
  colorless: number;
  /**
   * Number of `{X}` symbols. Not payable on its own: the caster announces a value for X
   * (CR 601.2b) and `withX` folds `x × chosen` into `generic`. Kept separate so the announced
   * value stays visible to the spell's own effects, which is what "deals X damage" reads.
   */
  x?: number;
  /** Hybrid pips, e.g. {G/U} → [['G', 'U']]. Payable with any symbol in the tuple. */
  hybrid?: (Color[])[];
}

export interface ManaCostParseResult {
  cost: ParsedManaCost | null;
  /** Symbols we cannot model yet ({X}, hybrid, Phyrexian, …); non-empty ⇒ cost is null. */
  unsupportedSymbols: string[];
}

export function emptyCost(): ParsedManaCost {
  return { generic: 0, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 };
}

const SYMBOL_RE = /\{([^}]+)\}/g;

/** Parse an oracle mana cost string. `null`/empty string parses as a zero cost. */
export function parseManaCost(cost: ManaCostString | null): ManaCostParseResult {
  const parsed = emptyCost();
  const unsupported: string[] = [];
  const costStr = cost !== null && cost !== '' ? cost.split(' // ')[0]! : '';
  if (costStr !== '') {
    for (const match of costStr.matchAll(SYMBOL_RE)) {
      const sym = match[1] as string;
      if (/^\d+$/.test(sym)) {
        parsed.generic += Number(sym);
      } else if ((ALL_COLORS as readonly string[]).includes(sym)) {
        parsed.colored[sym as Color] += 1;
      } else if (sym === 'C') {
        parsed.colorless += 1;
      } else if (sym === 'X') {
        parsed.x = (parsed.x ?? 0) + 1;
      } else if (sym.includes('/')) {
        const parts = sym.split('/');
        const colors = parts.map((p) => p.toUpperCase() as Color);
        if (colors.every((c) => (ALL_COLORS as readonly string[]).includes(c))) {
          if (!parsed.hybrid) parsed.hybrid = [];
          parsed.hybrid.push(colors);
        } else {
          unsupported.push(`{${sym}}`);
        }
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

/**
 * The concrete cost of a spell announced with X = `chosen` (CR 601.2b). Each `{X}` symbol
 * becomes `chosen` generic mana, and the `x` marker is dropped so nothing double-counts it.
 */
export function withX(cost: ParsedManaCost, chosen: number): ParsedManaCost {
  const { x = 0, ...rest } = cost;
  return { ...rest, colored: { ...cost.colored }, generic: cost.generic + x * chosen };
}

/** Cost `minus` generic mana, floored at zero (CR 601.2f — a reduction never pays you). */
export function subtractGeneric(cost: ParsedManaCost, minus: number): ParsedManaCost {
  return {
    ...cost,
    colored: { ...cost.colored },
    generic: Math.max(0, cost.generic - minus),
  };
}

/** Cost `minus` colored mana symbols, floored at zero (CR 601.2f). */
export function subtractColored(cost: ParsedManaCost, reduction: ParsedManaCost): ParsedManaCost {
  const newColored = { ...cost.colored };
  for (const c of ALL_COLORS) {
    const r = reduction.colored[c] ?? 0;
    if (r > 0) {
      newColored[c] = Math.max(0, newColored[c] - r);
    }
  }
  return {
    ...cost,
    colored: newColored,
  };
}

/** Render a parsed cost back as symbols — "{2}{G}{G}" — for prompts and option descriptions. */
export function describeManaCost(cost: ParsedManaCost): string {
  const parts: string[] = [];
  if (cost.generic > 0) parts.push(`{${cost.generic}}`);
  for (const c of ALL_COLORS) parts.push(`{${c}}`.repeat(cost.colored[c]));
  parts.push('{C}'.repeat(cost.colorless));
  if (cost.hybrid) {
    for (const h of cost.hybrid) parts.push(`{${h.join('/')}}`);
  }
  const out = parts.join('');
  return out === '' ? '{0}' : out;
}

export function totalPips(cost: ParsedManaCost): number {
  return (
    cost.generic +
    cost.colorless +
    ALL_COLORS.reduce((sum, c) => sum + cost.colored[c], 0) +
    (cost.hybrid?.length ?? 0)
  );
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
  /**
   * CR 106.6 restriction carried by the mana this source produces — "spend this mana only to
   * cast a Dragon creature spell" (Haven of the Spirit Dragon). The solver drops the whole
   * source when the restriction disallows the payment; see `planPayment`.
   */
  restriction?: ManaRestriction;
  /** Rides onto the mana produced — "when you spend this mana to cast X, …". */
  spendTrigger?: ManaSpendTrigger;
  /** Rides onto the mana produced — it survives the end-of-step drain (Klauth). */
  persistent?: boolean;
  /**
   * "…add two mana of any ONE color" (Ilysian Caryatid) — every unit of this source must
   * resolve to the SAME symbol. Only meaningful with more than one unit; forces the backtracker
   * rather than the single-choice fast path, because the fast path treats units independently.
   */
  linked?: true;
}

/** One mana produced by tapping a source, and which source produced it. */
export interface ProducedMana {
  cardId: string;
  symbol: Color | 'C';
}

export interface PaymentPlan {
  /**
   * Card ids of the sources to activate, in a deterministic order. Named for the {T} cost
   * every Phase 2 source had; a source with a different cost (Reckless Barbarian's "sacrifice
   * this creature") appears here too, and the caller pays whatever that source's cost is.
   */
  tapCardIds: string[];
  /** Summary of the floating mana the plan intends to consume. Informational. */
  fromPool: ManaPool;
  /**
   * Mana added to the pool by tapping `tapCardIds` — the SPECIFIC symbol chosen for each
   * produced unit (for multi-symbol sources, the choice that pays the cost). Callers must
   * add exactly this to the pool; re-deriving it from a source's first symbol mispays a
   * multi-color source (e.g. a {W}-or-{U} land used to pay {U}).
   *
   * Attributed per source, because the restriction and spend trigger a produced mana carries
   * come from the ability that made it — an unattributed count cannot say which.
   */
  produced: ProducedMana[];
}

/**
 * Decides whether restricted mana may pay for the payment in progress (CR 106.6).
 *
 * Supplied by the caller rather than evaluated here, so this module stays free of game state:
 * answering "is this a Dragon creature spell?" needs card definitions and, for Path of Ancestry,
 * the controller's commander. See `state/queries.ts::manaRestrictionAllows`.
 *
 * The default refuses every restriction. That is the safe direction — an unmodeled purpose
 * cannot silently unlock "spend only on X" mana (brief §6.3).
 */
export type ManaAllowance = (restriction: ManaRestriction) => boolean;

const ALLOW_NOTHING: ManaAllowance = () => false;

/** Is this mana spendable on the payment in progress? Unrestricted mana always is. */
export function entryIsUsable(entry: ManaEntry, allows: ManaAllowance): boolean {
  return entry.restriction === undefined || allows(entry.restriction);
}

/**
 * Decide whether `cost` can be paid from the floating pool plus some subset of `sources`,
 * and if so return a deterministic plan (which sources to tap, what to take from the pool).
 *
 * The engine auto-pays costs: which lands to tap is engine-chosen, not an AI decision
 * (recorded as a Phase 2 scope decision — the strategic content of tap choices is
 * negligible compared to the API cost of asking). The solver is exact: it backtracks over
 * per-unit symbol choices, so multi-color sources never cause a false "cannot pay".
 *
 * **Restrictions do not enter the search.** A CR 106.6 restriction is a property of the payment
 * as a whole, not of an individual pip, so `allows` resolves each one to a single boolean up
 * front and disallowed mana is simply removed from the inputs. What remains is the problem the
 * solver already solved exactly — mana of the same symbol is interchangeable again — so the
 * pre-existing exactness argument carries over untouched instead of needing a new dimension.
 *
 * **Several sources may share a `cardId`.** One permanent with mana abilities that are not
 * interchangeable — Haven of the Spirit Dragon's plain {C} and its Dragons-only any-color —
 * offers them as ALTERNATIVES, and the solver taps at most one per permanent. That is what
 * "it can only be tapped once" means once collapsing them into a single multi-choice unit stops
 * being sound.
 *
 * Deterministic given identical inputs: sources are considered in the order supplied
 * (callers supply battlefield order), pool mana is preferred over tapping.
 */
export function planPayment(
  cost: ParsedManaCost,
  poolEntries: readonly ManaEntry[],
  sources: readonly ManaSource[],
  allows: ManaAllowance = ALLOW_NOTHING,
): PaymentPlan | null {
  // Drop everything this payment may not legally spend, then solve the unrestricted problem.
  const usableEntries = poolEntries.filter((e) => entryIsUsable(e, allows));
  const usableSources = sources.filter(
    (s) => s.restriction === undefined || allows(s.restriction),
  );

  // Work on a mutable remaining-cost copy. Strategy: satisfy colored + {C} pips first
  // (they are the constrained ones), then generic from whatever remains.
  const remaining: ParsedManaCost = {
    generic: cost.generic,
    colored: { ...cost.colored },
    colorless: cost.colorless,
    ...(cost.hybrid ? { hybrid: [...cost.hybrid] } : {}),
  };
  const poolLeft: ManaPool = summarize(usableEntries);
  const fromPool = emptyPool();

  // 1. Pay what we can from the floating pool: colored pips, then hybrid pips, then {C}, then generic
  for (const c of ALL_COLORS) {
    const take = Math.min(remaining.colored[c], poolLeft[c]);
    remaining.colored[c] -= take;
    poolLeft[c] -= take;
    fromPool[c] += take;
  }
  if (remaining.hybrid && remaining.hybrid.length > 0) {
    const stillNeeded: (Color[])[] = [];
    for (const h of remaining.hybrid) {
      const availableColor = h.find((c) => poolLeft[c] > 0);
      if (availableColor !== undefined) {
        poolLeft[availableColor] -= 1;
        fromPool[availableColor] += 1;
      } else {
        stillNeeded.push(h);
      }
    }
    remaining.hybrid = stillNeeded;
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

  // 2. Cover the rest by tapping sources.
  const need = remaining;
  if (totalPips(need) === 0) return { tapCardIds: [], fromPool, produced: [] };

  const hasAlternatives = new Set(usableSources.map((s) => s.cardId)).size !== usableSources.length;
  const hasHybrid = (cost.hybrid?.length ?? 0) > 0;
  if (!hasHybrid && !hasAlternatives && usableSources.every((s) => s.units.every((u) => u.length === 1))) {
    return planSingleChoice(need, usableSources, fromPool);
  }

  // Backtracking over sources: for each source decide tap / don't tap; for each unit of
  // a tapped source decide which symbol it produces and which pip it covers (or floats).
  // Source counts are small (≤ dozens of lands), and we prune on total production. The
  // `produced` accumulator records the symbol actually chosen for each unit of every tapped
  // source (pushes are undone on backtrack), so callers add exactly what was chosen.
  const chosen: string[] = [];
  const produced: ProducedMana[] = [];

  const solve = (srcIdx: number, need2: ParsedManaCost): boolean => {
    if (totalPips(need2) === 0) return true;
    if (srcIdx >= usableSources.length) return false;
    // Prune: remaining sources cannot produce enough units.
    let unitsLeft = 0;
    for (let i = srcIdx; i < usableSources.length; i++)
      unitsLeft += (usableSources[i] as ManaSource).units.length;
    if (unitsLeft < totalPips(need2)) return false;

    const src = usableSources[srcIdx] as ManaSource;
    // Alternatives of one permanent share a cardId; it can only be tapped once.
    if (chosen.includes(src.cardId)) return solve(srcIdx + 1, need2);

    // Option A: tap this source. Assign each unit to a pip (or let it float). A tapped
    // source produces ALL its units, so each unit adds a symbol to `produced`.
    //
    // `forced`, once set, is the symbol every remaining unit of a LINKED source must also
    // produce (Ilysian Caryatid's "two mana of any ONE color") — set from whatever the first
    // unit chose, and never cleared for the rest of this source's units.
    const assignUnits = (
      unitIdx: number,
      needNow: ParsedManaCost,
      forced?: Color | 'C',
    ): boolean => {
      if (unitIdx >= src.units.length) {
        return solve(srcIdx + 1, needNow);
      }
      const unit = src.units[unitIdx] as ManaUnit;
      const candidates = forced === undefined ? unit : unit.filter((s) => s === forced);
      const attempt = (sym: Color | 'C', next: ParsedManaCost): boolean => {
        produced.push({ cardId: src.cardId, symbol: sym });
        if (assignUnits(unitIdx + 1, next, src.linked === true ? sym : forced)) return true;
        produced.pop();
        return false;
      };
      for (const sym of candidates) {
        // Cover a colored pip / a hybrid pip / a {C} pip / a generic pip with this symbol.
        if (sym !== 'C' && needNow.colored[sym] > 0) {
          const next = { ...needNow, colored: { ...needNow.colored } };
          next.colored[sym] -= 1;
          if (attempt(sym, next)) return true;
        }
        if (sym !== 'C' && needNow.hybrid && needNow.hybrid.length > 0) {
          const hIdx = needNow.hybrid.findIndex((h) => h.includes(sym as Color));
          if (hIdx !== -1) {
            const nextHybrid = [...needNow.hybrid];
            nextHybrid.splice(hIdx, 1);
            const next = { ...needNow, colored: { ...needNow.colored }, hybrid: nextHybrid };
            if (attempt(sym, next)) return true;
          }
        }
        if (sym === 'C' && needNow.colorless > 0) {
          const next = { ...needNow, colored: { ...needNow.colored } };
          next.colorless -= 1;
          if (attempt('C', next)) return true;
        }
        if (needNow.generic > 0) {
          const next = { ...needNow, colored: { ...needNow.colored } };
          next.generic -= 1;
          if (attempt(sym, next)) return true;
        }
      }
      // Let this unit float (produce surplus): it still yields mana — record its first
      // (candidate, so a linked unit floats the forced color) symbol so `produced` matches
      // what tapping actually adds to the pool.
      return attempt((candidates[0] ?? unit[0]) as Color | 'C', needNow);
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
  sources: readonly ManaSource[],
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
  // produces all its units; `produced` lists every one, attributed to the source that made it.
  const tappedProds = prods.filter((p) => tapped.has(p));
  const produced: ProducedMana[] = [];
  for (const p of tappedProds) {
    for (const unit of p.source.units) {
      produced.push({ cardId: p.source.cardId, symbol: unit[0] as Color | 'C' });
    }
  }
  const tapCardIds = tappedProds.map((p) => p.source.cardId);
  return { tapCardIds, fromPool, produced };
}

/** True iff `cost` is payable from the floating pool + `sources`, for this payment's purpose. */
export function canPay(
  cost: ParsedManaCost,
  poolEntries: readonly ManaEntry[],
  sources: readonly ManaSource[],
  allows: ManaAllowance = ALLOW_NOTHING,
): boolean {
  return planPayment(cost, poolEntries, sources, allows) !== null;
}
