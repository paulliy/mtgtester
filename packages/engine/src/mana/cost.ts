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
  Effect,
  ManaEntry,
  ManaRestriction,
  ManaSpendTrigger,
} from '../cards/ability';
import { emptyPool, selectEntriesToSpend, summarize } from './pool';

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
  hybrid?: Color[][];
  /** Phyrexian pips, each payable with its color or 2 life (CR 107.4f). */
  phyrexian?: Color[];
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
      } else if (/^[WUBRG]\/P$/.test(sym)) {
        if (!parsed.phyrexian) parsed.phyrexian = [];
        parsed.phyrexian.push(sym[0] as Color);
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
  if (cost.phyrexian) {
    for (const color of cost.phyrexian) parts.push(`{${color}/P}`);
  }
  const out = parts.join('');
  return out === '' ? '{0}' : out;
}

/**
 * Mana value of a cost with X read as 0 (CR 202.3b's "not on the stack" case) — a permanent's
 * mana value, as opposed to a spell's while it's still resolving with an announced X (see
 * `spellManaValue` in `state/objects.ts`, which this mirrors for the X=0 case; kept here rather
 * than imported there so `effects/continuous.ts` — which needs this for `candidateOf`'s
 * `manaValueAtMost`/`manaValueAtLeast` support — doesn't have to import `state/objects.ts` and
 * create a cycle back through it).
 */
export function manaValueOf(cost: ParsedManaCost | null): number {
  if (cost === null) return 0;
  const colored = ALL_COLORS.reduce((sum, c) => sum + cost.colored[c], 0);
  return (
    cost.generic +
    colored +
    cost.colorless +
    (cost.hybrid?.length ?? 0) +
    (cost.phyrexian?.length ?? 0)
  );
}

export function totalPips(cost: ParsedManaCost): number {
  return (
    cost.generic +
    cost.colorless +
    ALL_COLORS.reduce((sum, c) => sum + cost.colored[c], 0) +
    (cost.hybrid?.length ?? 0) +
    (cost.phyrexian?.length ?? 0)
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
   * What activating it costs. The solver ignores the non-mana components — availability was
   * already decided — but the caller applying the plan needs them, because "tap it" is not the
   * only way to pay.
   */
  costs: readonly AbilityCost[];
  /**
   * The MANA component of `costs`, if any — a filter land's `{W/B}`, Cabal Coffers' `{2}`.
   *
   * Unlike the rest of `costs` this one *is* the solver's business: a source that costs mana is
   * a net producer, and whether it helps depends on what else is available. See `planPayment`'s
   * second pass. Absent for the overwhelming majority of sources, which are free to activate.
   */
  manaCost?: ParsedManaCost;
  /**
   * CR 106.6 restriction carried by the mana this source produces — "spend this mana only to
   * cast a Dragon creature spell" (Haven of the Spirit Dragon). The solver drops the whole
   * source when the restriction disallows the payment; see `planPayment`.
   */
  restriction?: ManaRestriction;
  /** Rides onto the mana produced — "when you spend this mana to cast X, …". */
  spendTrigger?: ManaSpendTrigger;
  /** If this mana is spent to cast a spell, that spell becomes uncounterable. */
  uncounterableSpell?: true;
  /** Rides onto the mana produced — it survives the end-of-step drain (Klauth). */
  persistent?: boolean;
  /**
   * Non-mana effects the ability applies when activated — a painland's "deals 1 damage to you",
   * Ancient Tomb's 2. Carried on the SOURCE rather than re-read from the permanent, because a
   * permanent with several mana abilities has several riders and only the activated one applies;
   * `interchangeableSignature` keeps abilities with different riders in different sources.
   */
  onActivate?: readonly Effect[];
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
  /**
   * The specific `ManaSource` the plan chose for each entry of `tapCardIds`, same order and
   * length.
   *
   * A permanent with several non-interchangeable mana abilities contributes several sources that
   * all share a `cardId` (Ancient Tomb's {C} and its {C}{C}), so the card id alone does not say
   * which ability was activated — and the riders, restrictions and activation cost that must be
   * applied all belong to that one ability. Recorded by the solver rather than re-derived by the
   * applier, so the two cannot disagree.
   */
  tapSources: ManaSource[];
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
  /** Life used for Phyrexian pips. */
  lifePaid?: number;
  /** Concrete mana-only cost after choosing how each Phyrexian pip is paid. */
  resolvedCost?: ParsedManaCost;
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
 * **A source may cost mana to activate** — a filter land's `{W/B}`, Cabal Coffers' `{2}`. Those
 * are held out of the ordinary solve and reached for only when it fails, because they are the
 * strictly worse way to make mana and because bringing them in costs the exactness of the
 * restricted-mana argument above (see `solveWithCostly`). When one is used, the returned
 * `tapCardIds` are in an order the applier can actually execute, not merely a set that balances.
 *
 * Deterministic given identical inputs: sources are considered in the order supplied
 * (callers supply battlefield order), pool mana is preferred over tapping.
 */
export function planPayment(
  cost: ParsedManaCost,
  poolEntries: readonly ManaEntry[],
  sources: readonly ManaSource[],
  allows: ManaAllowance = ALLOW_NOTHING,
  lifeTotal = 0,
): PaymentPlan | null {
  if ((cost.phyrexian?.length ?? 0) > 0) {
    const pips = cost.phyrexian as Color[];
    const expand = (
      index: number,
      colored: ParsedManaCost['colored'],
      lifePaid: number,
    ): PaymentPlan | null => {
      if (index === pips.length) {
        if (lifePaid > lifeTotal) return null;
        const resolvedCost: ParsedManaCost = {
          ...cost,
          colored,
        };
        delete resolvedCost.phyrexian;
        const plan = planPayment(resolvedCost, poolEntries, sources, allows, lifeTotal - lifePaid);
        return plan === null
          ? null
          : {
              ...plan,
              lifePaid: (plan.lifePaid ?? 0) + lifePaid,
              resolvedCost,
            };
      }
      const color = pips[index] as Color;
      const mana = expand(index + 1, { ...colored, [color]: colored[color] + 1 }, lifePaid);
      if (mana !== null) return mana;
      return expand(index + 1, colored, lifePaid + 2);
    };
    return expand(0, cost.colored, 0);
  }
  // Hybrid choices must be solved jointly with the floating pool and sources. Greedy
  // consumption loses legal payments such as {W/U}{W/B} from a W,U pool.
  if ((cost.hybrid?.length ?? 0) > 0) {
    const tried = new Set<string>();
    const expand = (index: number, colored: ParsedManaCost['colored']): PaymentPlan | null => {
      if (index === cost.hybrid!.length) {
        const key = ALL_COLORS.map((c) => colored[c]).join(',');
        if (tried.has(key)) return null;
        tried.add(key);
        return planPayment(
          { generic: cost.generic, colorless: cost.colorless, colored },
          poolEntries,
          sources,
          allows,
          lifeTotal,
        );
      }
      for (const color of cost.hybrid![index]!) {
        const result = expand(index + 1, { ...colored, [color]: colored[color] + 1 });
        if (result !== null) return result;
      }
      return null;
    };
    return expand(0, cost.colored);
  }
  // Drop everything this payment may not legally spend, then solve the unrestricted problem.
  const usableEntries = poolEntries.filter((e) => entryIsUsable(e, allows));
  const usableSources = sources.filter((s) => s.restriction === undefined || allows(s.restriction));

  // Sources that cost mana to activate are held back for a second pass (see `solveWithCostly`):
  // the first pass is byte-identical to the payment this function has always planned, so every
  // existing card's tap choices are unchanged and a filter land is only reached for.
  const freeSources = usableSources.filter((s) => s.manaCost === undefined);
  const firstPass = solveFrom(cost, usableEntries, freeSources);
  if (firstPass !== null || freeSources.length === usableSources.length) return firstPass;
  return solveWithCostly(cost, usableEntries, usableSources);
}

/**
 * The second pass: solve again with mana-costing sources in play, then put the activations in an
 * order that can actually be executed.
 *
 * **Restricted mana is dropped wholesale here**, pool entries and sources alike. Whether a
 * CR 106.6 restriction lets its mana pay for *activating a mana ability* is a different question
 * from whether it may pay for the spell this payment is for, and the solver's exactness argument
 * rests on every remaining mana being interchangeable. Rather than add that dimension for a
 * combination no real board reaches — restricted mana and a filter land in one payment — this
 * fails closed: the payment is declared impossible, never mispaid.
 */
function solveWithCostly(
  cost: ParsedManaCost,
  usableEntries: readonly ManaEntry[],
  usableSources: readonly ManaSource[],
): PaymentPlan | null {
  const entries = usableEntries.filter((e) => e.restriction === undefined);
  const sources = usableSources.filter((s) => s.restriction === undefined);
  const plan = solveFrom(cost, entries, sources);
  return plan === null ? null : orderForActivation(cost, entries, plan);
}

/**
 * The mana component of an activation cost, or undefined when activating costs no mana.
 *
 * `{0}` answers undefined too: a zero cost and no cost are the same source, and keeping them
 * distinct would push a free ability onto `planPayment`'s slower second pass for nothing.
 */
export function manaCostComponent(costs: readonly AbilityCost[]): ParsedManaCost | undefined {
  let total: ParsedManaCost | undefined;
  for (const cost of costs) {
    if (cost.kind !== 'mana') continue;
    total = total === undefined ? cost.cost : addCosts(total, cost.cost);
  }
  return total !== undefined && totalPips(total) > 0 ? total : undefined;
}

/** `a` plus `b`, pip for pip. `{X}` is not representable in an activation cost and is dropped. */
function addCosts(a: ParsedManaCost, b: ParsedManaCost): ParsedManaCost {
  const colored = { ...a.colored };
  for (const c of ALL_COLORS) colored[c] += b.colored[c];
  const hybrid = [...(a.hybrid ?? []), ...(b.hybrid ?? [])];
  const phyrexian = [...(a.phyrexian ?? []), ...(b.phyrexian ?? [])];
  return {
    generic: a.generic + b.generic,
    colored,
    colorless: a.colorless + b.colorless,
    ...(hybrid.length > 0 ? { hybrid } : {}),
    ...(phyrexian.length > 0 ? { phyrexian } : {}),
  };
}

/**
 * Put a plan's activations in an order that can be executed, and verify it end to end.
 *
 * The solver's arithmetic is a *bag* argument — total production covers the cost plus every
 * activation cost — which says nothing about timing, and you cannot spend mana you have not made
 * yet. Free sources always go first (they only add). The mana-costing ones are then ordered by
 * search, and the whole sequence is replayed with `selectEntriesToSpend`, the same function
 * `payManaCost` will use, so the plan the applier receives is one it is known to be able to
 * execute — including the final payment of `cost` from what is left.
 *
 * Returns null when no order works, which is the fail-closed direction: the source is simply not
 * offered.
 */
function orderForActivation(
  cost: ParsedManaCost,
  poolEntries: readonly ManaEntry[],
  plan: PaymentPlan,
): PaymentPlan | null {
  const free: ManaSource[] = [];
  const costly: ManaSource[] = [];
  for (const source of plan.tapSources)
    (source.manaCost === undefined ? free : costly).push(source);
  // Guard against a factorial search. No real board has this many mana-costing sources in one
  // payment; refusing is fail-closed.
  if (costly.length > 6) return null;

  const producedBy = (source: ManaSource): ManaEntry[] =>
    plan.produced.filter((p) => p.cardId === source.cardId).map(({ symbol }) => ({ symbol }));

  const start: ManaEntry[] = [...poolEntries];
  for (const source of free) start.push(...producedBy(source));

  const order: ManaSource[] = [];
  const search = (available: readonly ManaEntry[], remaining: readonly ManaSource[]): boolean => {
    if (remaining.length === 0) return selectEntriesToSpend(available, cost) !== null;
    for (const source of remaining) {
      const spent = selectEntriesToSpend(available, source.manaCost as ParsedManaCost);
      if (spent === null) continue;
      const next = available.filter((e) => !spent.includes(e));
      order.push(source);
      if (
        search(
          [...next, ...producedBy(source)],
          remaining.filter((s) => s !== source),
        )
      ) {
        return true;
      }
      order.pop();
    }
    return false;
  };
  if (!search(start, costly)) return null;

  const tapSources = [...free, ...order];
  return { ...plan, tapSources, tapCardIds: tapSources.map((s) => s.cardId) };
}

/** The exact solve over a fixed set of usable entries and sources. */
function solveFrom(
  cost: ParsedManaCost,
  usableEntries: readonly ManaEntry[],
  usableSources: readonly ManaSource[],
): PaymentPlan | null {
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
    const stillNeeded: Color[][] = [];
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
  if (totalPips(need) === 0) return { tapCardIds: [], tapSources: [], fromPool, produced: [] };

  const hasAlternatives = new Set(usableSources.map((s) => s.cardId)).size !== usableSources.length;
  const hasHybrid = (cost.hybrid?.length ?? 0) > 0;
  // A source that costs mana breaks the fast path's credit accounting, which assumes tapping a
  // source is pure gain. Those only ever reach here on `planPayment`'s second pass, so the fast
  // path still covers every payment it covered before.
  const hasCostly = usableSources.some((s) => s.manaCost !== undefined);
  if (
    !hasHybrid &&
    !hasAlternatives &&
    !hasCostly &&
    usableSources.every((s) => s.units.every((u) => u.length === 1))
  ) {
    return planSingleChoice(need, usableSources, fromPool);
  }

  // Backtracking over sources: for each source decide tap / don't tap; for each unit of
  // a tapped source decide which symbol it produces and which pip it covers (or floats).
  // Source counts are small (≤ dozens of lands), and we prune on total production. The
  // `produced` accumulator records the symbol actually chosen for each unit of every tapped
  // source (pushes are undone on backtrack), so callers add exactly what was chosen.
  const chosen: ManaSource[] = [];
  const produced: ProducedMana[] = [];

  // Optimistic suffix bounds: alternative abilities and linked production may be
  // double-counted here, which only weakens pruning and cannot reject a legal payment.
  const suffix = Array.from({ length: usableSources.length + 1 }, () => emptyPool());
  for (let i = usableSources.length - 1; i >= 0; i--) {
    Object.assign(suffix[i]!, suffix[i + 1]!);
    for (const unit of usableSources[i]!.units) {
      for (const symbol of new Set(unit)) suffix[i]![symbol]++;
    }
  }
  const solve = (srcIdx: number, need2: ParsedManaCost): boolean => {
    if (totalPips(need2) === 0) return true;
    if (srcIdx >= usableSources.length) return false;
    for (const color of ALL_COLORS) {
      if (need2.colored[color] > suffix[srcIdx]![color]) return false;
    }
    if (need2.colorless > suffix[srcIdx]!.C) return false;
    // Prune: remaining sources cannot produce enough units.
    let unitsLeft = 0;
    for (let i = srcIdx; i < usableSources.length; i++)
      unitsLeft += (usableSources[i] as ManaSource).units.length;
    if (unitsLeft < totalPips(need2)) return false;

    const src = usableSources[srcIdx] as ManaSource;
    // Alternatives of one permanent share a cardId; it can only be tapped once.
    if (chosen.some((s) => s.cardId === src.cardId)) return solve(srcIdx + 1, need2);

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
        if (totalPips(needNow) >= totalPips(need2)) return false;
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

    chosen.push(src);
    // A source that costs mana to activate adds its own cost to what still has to be found:
    // the payment as a whole must cover `cost` PLUS every activation cost it pays along the
    // way. `assignUnits`'s terminal test still compares against the un-augmented `need2`, so
    // a source that does not net-reduce the need is pruned — a Cabal Coffers with one Swamp
    // costs {2} to make {B} and is correctly declined.
    if (assignUnits(0, src.manaCost === undefined ? need2 : addCosts(need2, src.manaCost))) {
      return true;
    }
    chosen.pop();

    // Option B: skip this source.
    return solve(srcIdx + 1, need2);
  };

  if (!solve(0, need)) return null;
  return { tapCardIds: chosen.map((s) => s.cardId), tapSources: [...chosen], fromPool, produced };
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
  return { tapCardIds, tapSources: tappedProds.map((p) => p.source), fromPool, produced };
}

/** True iff `cost` is payable from the floating pool + `sources`, for this payment's purpose. */
export function canPay(
  cost: ParsedManaCost,
  poolEntries: readonly ManaEntry[],
  sources: readonly ManaSource[],
  allows: ManaAllowance = ALLOW_NOTHING,
  lifeTotal = 0,
): boolean {
  return planPayment(cost, poolEntries, sources, allows, lifeTotal) !== null;
}
