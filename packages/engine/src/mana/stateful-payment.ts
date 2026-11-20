import { copyData } from '../state/copy-data';
import { getCached, setCached, shareDefinitionIds } from '../effects/layer-cache';
import { playerLifeLocked } from '../state/phasing';
import type { EnginePlayerState, GameContext } from '../state/types';
import type {
  ManaAllowance,
  ManaSource,
  ManaUnit,
  ParsedManaCost,
  PaymentPlan,
  ProducedMana,
} from './cost';
import { emptyCost, planPayment } from './cost';
import { payManaCost } from '../effects/resolve';
import { UnmodeledCardError } from '../errors';
import type { PendingDecision } from '../decisions';
import { battlefieldCharacteristics } from '../effects/continuous';
import type { ManaAbilitySpec } from '../cards/ability';
import { activationInvariantProduction } from '../cards/mana-production';
import { totalPips } from './cost';
import type { ManaEntry } from '../cards/ability';
import { orderByKeepValue } from './tap-preference';
import {
  otherManaDemand,
  resolveConditionalUnits,
  resolveDynamicAmount,
  resolveDynamicUnits,
} from '../state/queries';
import {
  characteristicsFixedDuringPayment,
  definitionsInPlay,
  gateCannotOpenDuringPayment,
  leavingPermanentsKeepProduction,
} from './payment-stability';
import { countWork } from '../work-counters';

const bounds = { states: 2048, activations: 32, productions: 256, lifeGainOrders: 64 };

/** A decision that only orders life-gain replacements (`replaceLifeGain`, CR 616.1). */
function onlyLifeGainOrder(decision: PendingDecision): boolean {
  return (
    decision.options.length > 0 &&
    decision.options.every((option) => option.type === 'lifeGainReplacement')
  );
}
/**
 * A copy to replay activations on. It leaves out the spectator snapshots and the debug log: no
 * rule reads them, and where nothing drains them (a bot game, a test) they grow with every event.
 * Logged events are appended and never edited, and a definition is replaced whole, never edited
 * (`ctx.defs.set`), so the copy shares both and owns only its log and map. Deep-copying all of it
 * made each searched state of a 58-turn fuzz game cost over a second.
 */
function clone(ctx: GameContext): GameContext {
  countWork('stateCopies');
  const { sequenceSnapshots: _snapshots, eventLog, ...state } = ctx.state;
  const copy: GameContext = {
    state: { ...copyData(state), eventLog: eventLog.slice() },
    defs: new Map(ctx.defs),
    debugLog: [],
    rng: ctx.rng.clone(),
  };
  // The copy starts with the original's layer results: its state is the same, and the cache is
  // checked against a digest of the copy's own state on every read, so a copy that diverges
  // recomputes. Starting cold cost a full layer pass for every state the search visits.
  shareDefinitionIds(ctx, copy);
  const layers = getCached(ctx);
  if (layers !== undefined) setCached(copy, layers);
  return copy;
}

/**
 * The most a source can produce while no activation can raise production: its units. That holds
 * for a dynamic source too (Exotic Orchard, Reflecting Pool, Mox Amber): `manaSourcesFor` has
 * already resolved its symbols in this state. They are read from permanents' characteristics,
 * exile contents, entry choices and commander identity, and a fixed-capacity activation (tap and
 * mana costs, a life gain or damage rider) changes none of them. That is the same premise the
 * count bound rests on: if an activation could change a characteristic, it could add a mana
 * ability too. Counting the dynamic source as "any type" instead let an Orchard that makes only
 * {G} pass for a white source, and the search tried every subset of the other lands to disprove
 * it. A conditional amount (`conditionalUnits`) is bounded by its largest alternative. Null for
 * production no ceiling covers: a counted amount or a rider's addition.
 */
function ceilingUnits(source: ManaSource): ManaUnit[] | null {
  if (source.stateDependentProduction !== true) return source.units;
  const spec = source.productionSpec;
  if (spec === undefined || spec.amount !== undefined) return null;
  if (spec.conditionalUnits !== undefined) {
    // "Add one mana of any color; two of any one color if you control a power 4+ creature"
    // (Ilysian Caryatid): which alternative applies can change with the board, so bound it by
    // all of them. Each position offers every symbol any alternative offers there (the units
    // resolved in this state are one of the alternatives), and the source makes as many units
    // as its largest alternative. An overestimate can only prune an impossible payment.
    const alternatives = [source.units, spec.units, spec.conditionalUnits.units];
    const count = Math.max(...alternatives.map((units) => units.length));
    return Array.from({ length: count }, (_unused, position) => [
      ...new Set(alternatives.flatMap((units) => units[position] ?? [])),
    ]);
  }
  if (spec.dynamic === undefined) return null;
  return source.units;
}

/**
 * The source as the colored bound sees it: at its ceiling units. A conditional source's
 * alternatives disagree on `linked` (and an activation can flip which one applies), so its ceiling
 * must not keep the constraint of the alternative resolved now.
 */
function ceilingSource(source: ManaSource, units: ManaUnit[]): ManaSource {
  if (source.productionSpec?.conditionalUnits === undefined) return { ...source, units };
  const { linked: _linked, ...unlinked } = source;
  return { ...unlinked, units };
}

/** Dynamic mana kinds that read nothing a sacrifice of the player's own permanent changes. */
const DYNAMIC_KINDS_OUTSIDE_OWN_BOARD: ReadonlySet<string> = new Set([
  'commanderIdentity',
  'chosenColor',
  'opponentLandColors',
]);

/**
 * Fields of a permanent that are only its identity: two permanents equal in everything else are
 * interchangeable to the payment search. `timestamp` orders continuous effects (CR 613.7), which
 * matters only while characteristics can change during the payment (see `classKeyOf`).
 */
const IDENTITY_FIELDS = new Set(['id', 'cardId']);

/** A permanent-shaped or card-shaped object, whose own `id` and `cardId` name only itself. */
function isGameObject(holder: unknown): boolean {
  return (
    typeof holder === 'object' &&
    holder !== null &&
    'oracleId' in holder &&
    ('controllerId' in holder || 'ownerId' in holder)
  );
}

/**
 * Whether any state outside a permanent's own `id` and `cardId` fields names it: an Aura or
 * Equipment attached to it, a delayed trigger, a stack object, a continuous effect, a sacrifice
 * list. Such a permanent is not interchangeable with a lookalike, because a rule can single it
 * out. The log of events and the spectator snapshots are left out: no payment reads them, and
 * they are the bulk of the state.
 */
function referencedElsewhere(
  ctx: GameContext,
): (permanent: { id: string; cardId: string }) => boolean {
  let text: string | undefined;
  return (permanent) => {
    if (text === undefined) {
      const { sequenceSnapshots: _snapshots, eventLog: _log, ...state } = ctx.state;
      text = JSON.stringify(state, function (this: unknown, key: string, value: unknown) {
        return IDENTITY_FIELDS.has(key) && isGameObject(this) ? undefined : value;
      });
    }
    return text.includes(`"${permanent.id}"`) || text.includes(`"${permanent.cardId}"`);
  };
}

/**
 * Symmetry reduction for the payment search. Two untapped sources are interchangeable when
 * swapping their permanents maps the game onto itself, so the search needs to try only the first
 * of them at a level: what it explores under the second is isomorphic to what it explored under
 * the first, which found no plan (or it would have returned). The class key lists everything the
 * search and the payment can observe, and anything unlisted keeps two sources apart:
 *
 * - the permanent itself, every field but `id` and `cardId`: definition (`oracleId`), name,
 *   token or not, controller, tapped and summoning-sick status, counters, attachment, face,
 *   chosen option, copy and combat fields, `enteredTurnNumber`. `timestamp` is dropped only while
 *   characteristics are fixed during the payment (`characteristicsFixedDuringPayment`, the
 *   same answer in the verify run's old search, so both explore the same classes): then no effect can be reordered
 *   against it, and what the layers made of the permanent is in the key below. Where that
 *   fails, a later tap may re-run the layers, so the timestamp stays.
 * - what the layer pass makes of it (`characteristics`): types, subtypes, colors, keywords,
 *   power and toughness, and the mana abilities and their gates.
 * - every source it offers, not only this one (a permanent with two abilities is not like one
 *   with one), each without `cardId` and `activation`: units, costs, mana cost, production spec,
 *   riders, restriction, spend trigger and the rest of `ManaSource`.
 * - whether it is reserved (`reservedObjectIds`).
 * - that nothing else names it (`referencedElsewhere`).
 *
 * Where a source lists permanents by id (`sacrifices`, `taps`), spends a shared resource keyed by
 * its card, is convoke, or comes from the hand, nothing is merged at that level: a swap would
 * have to carry those lists along.
 */
function sourceClassKeys(
  snapshot: GameContext,
  available: readonly ManaSource[],
  reservedObjectIds: ReadonlySet<string>,
  fixedCharacteristics: boolean,
  referenced: (permanent: { id: string; cardId: string }) => boolean,
): (source: ManaSource) => string {
  const charsOf = battlefieldCharacteristics(snapshot);
  const exact = (source: ManaSource): string => {
    const { activation: _activation, ...signature } = source;
    return JSON.stringify(signature);
  };
  const bare = (source: ManaSource): string => {
    const { activation: _activation, cardId: _cardId, ...signature } = source;
    return JSON.stringify(signature);
  };
  const entangled = available.some(
    (source) =>
      source.sacrifices !== undefined ||
      source.taps !== undefined ||
      source.resources !== undefined ||
      source.convoke === true ||
      source.fromHand === true,
  );
  const siblings = new Map<string, string[]>();
  for (const source of available)
    siblings.set(source.cardId, [...(siblings.get(source.cardId) ?? []), bare(source)]);
  const cache = new Map<string, string>();
  return (source) => {
    if (entangled) return exact(source);
    const cached = cache.get(source.cardId);
    const own = bare(source);
    if (cached !== undefined) return `${cached}${own}`;
    const permanent = snapshot.state.battlefield.find((p) => p.cardId === source.cardId);
    let key: string;
    if (permanent === undefined || referenced(permanent)) key = `unique:${source.cardId}`;
    else
      key = JSON.stringify([
        JSON.stringify(permanent, function (this: unknown, field: string, value: unknown) {
          if (this !== permanent) return value;
          return IDENTITY_FIELDS.has(field) || (fixedCharacteristics && field === 'timestamp')
            ? undefined
            : value;
        }),
        JSON.stringify(charsOf(permanent)),
        siblings.get(source.cardId),
        reservedObjectIds.has(permanent.id) || reservedObjectIds.has(permanent.cardId),
      ]);
    cache.set(source.cardId, key);
    return `${key}${own}`;
  };
}

/**
 * Try first the symbol choices that cover a colored pip the cost still has unmet (the cost less
 * what the pool and the mana already produced cover). Without it a Treasure's first choice is
 * always {W}, and the depth-first search piled up white mana to the activation bound before it
 * ever tried another color: it sacrificed 32 Treasures to pay one {U}. The sort is stable, so the
 * existing order stays the tie-break, and it changes only the order in which a search tries
 * choices, never which ones it tries.
 */
function unmetColorsFirst(
  choices: ProducedMana[][],
  cost: ParsedManaCost,
  pool: readonly { symbol: string }[],
  produced: readonly { symbol: string }[],
): ProducedMana[][] {
  if (choices.length < 2) return choices;
  const unmet = new Map<string, number>();
  for (const [color, pips] of Object.entries(cost.colored)) if (pips > 0) unmet.set(color, pips);
  for (const { symbol } of [...pool, ...produced]) {
    const left = unmet.get(symbol);
    if (left !== undefined) unmet.set(symbol, left - 1);
  }
  const covered = (units: ProducedMana[]): number => {
    const used = new Map<string, number>();
    let count = 0;
    for (const { symbol } of units) {
      const left = (unmet.get(symbol) ?? 0) - (used.get(symbol) ?? 0);
      if (left > 0) {
        used.set(symbol, (used.get(symbol) ?? 0) + 1);
        count += 1;
      }
    }
    return count;
  };
  return choices
    .map((units, index) => ({ units, index, score: covered(units) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ units }) => units);
}

export function needsStatefulManaPayment(
  ctx: GameContext,
  player: EnginePlayerState,
  cost: ParsedManaCost,
  lifeReserved: number,
): boolean {
  const charsOf = battlefieldCharacteristics(ctx);
  const abilities = ctx.state.battlefield
    .filter((p) => p.controllerId === player.id)
    .flatMap((p) => charsOf(p).manaAbilities);
  return (
    abilities.some((a) => !activationInvariantProduction(a)) ||
    (abilities.some((a) => (a.onActivate?.length ?? 0) > 0) &&
      (lifeReserved > 0 ||
        (cost.phyrexian?.length ?? 0) > 0 ||
        abilities.some((a) =>
          a.costs?.some((c) => ['payLife', 'payLifeValue', 'removeCounters'].includes(c.kind)),
        )))
  );
}

/**
 * Set `MTG_VERIFY_MANA_PLAN=1` to run every stateful payment twice, once with the capacity bound
 * as it stood before gated sources could join it, and throw if the two disagree on the plan or on
 * the error. In the style of `MTG_VERIFY_LAYER_CACHE`; fuzz runs with it on.
 */
const VERIFY_MANA_PLAN =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'MTG_VERIFY_MANA_PLAN'
  ] === '1';

type Outcome = { plan: PaymentPlan | null } | { error: unknown };

function outcomeOf(run: () => PaymentPlan | null): Outcome {
  try {
    return { plan: run() };
  } catch (error) {
    return { error };
  }
}

function describeOutcome(outcome: Outcome): string {
  if ('plan' in outcome) return JSON.stringify(outcome.plan);
  const { error } = outcome;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** `searchTapOnly`'s answer when it cannot mirror the copying search exactly. */
const handBack = Symbol('hand back to the copying search');

/**
 * A source whose activation only taps its permanent and adds the mana chosen for it: a `{T}` cost
 * and nothing else, no rider, no convoke, nothing it consumes. Activating one changes the game
 * only by that tap, the pool, and triggers that wait for the stack, so under fixed capacity the
 * sources left afterwards are the same ones minus every ability of the tapped permanent.
 */
export function tapOnlySource(source: ManaSource): boolean {
  return (
    source.costs.length === 1 &&
    source.costs[0]!.kind === 'tap' &&
    source.manaCost === undefined &&
    (source.onActivate?.length ?? 0) === 0 &&
    source.convoke !== true &&
    source.sacrifices === undefined &&
    source.taps === undefined &&
    source.resources === undefined &&
    (source.stateDependentProduction !== true || source.productionSpec !== undefined)
  );
}

/**
 * A source that pays by sacrificing and makes a fixed amount of mana (Ashnod's Altar, Phyrexian
 * Altar, Illuminor Szeras once its victim is pinned). Its production is already resolved and no
 * activation of it can raise what another source makes, so the final payment solves it exactly,
 * victims included, instead of the search replaying it: a replay would have to name the victim,
 * and the victim is the player's choice (the plan carries the source unpinned, and paying asks).
 */
export function sacrificeSource(source: ManaSource): boolean {
  return (
    source.sacrifices !== undefined &&
    source.convoke !== true &&
    source.productionSpec === undefined &&
    source.stateDependentProduction !== true &&
    source.costs.every(
      (cost) => cost.kind === 'tap' || cost.kind === 'mana' || cost.kind === 'sacrificeOther',
    )
  );
}

/** Mirror of the entries `payManaCost` adds for one activation. */
function entriesFor(
  source: ManaSource,
  produced: readonly ProducedMana[],
  fromTreasure: boolean,
): ManaEntry[] {
  return produced.map(({ symbol }) => ({
    symbol,
    ...(source.restriction !== undefined ? { restriction: source.restriction } : {}),
    ...(source.spendTrigger !== undefined ? { spendTrigger: source.spendTrigger } : {}),
    ...(source.uncounterableSpell === true ? { uncounterableSpell: true as const } : {}),
    ...(fromTreasure ? { fromTreasure: true as const } : {}),
    ...(source.persistent === true ? { persistent: true } : {}),
  }));
}

/** Actual activation replay, including post-cost production, with no strategic cost decisions. */
export function planStatefulManaPayment(
  ctx: GameContext,
  player: EnginePlayerState,
  cost: ParsedManaCost,
  allows: ManaAllowance,
  sourcesFor: (ctx: GameContext, player: EnginePlayerState) => readonly ManaSource[],
  reservedObjectIds: ReadonlySet<string>,
  lifeReserved: number,
  energyReserved: number,
): PaymentPlan | null {
  const run = (current: boolean) =>
    searchPayment(
      ctx,
      player,
      cost,
      allows,
      sourcesFor,
      reservedObjectIds,
      lifeReserved,
      energyReserved,
      current,
    );
  if (!VERIFY_MANA_PLAN) return run(true);
  // Without the premise the current search drops the bound the old one trusted, so it may find a
  // payment the old one wrongly ruled out; there is nothing to compare against.
  if (!characteristicsFixedDuringPayment(definitionsInPlay(ctx))) return run(true);
  const legacy = outcomeOf(() => run(false));
  const current = outcomeOf(() => run(true));
  const [was, now] = [describeOutcome(legacy), describeOutcome(current)];
  if (was !== now)
    throw new Error(
      `engine bug: mana plan verification failed for ${player.id}: before ${was}, now ${now}`,
    );
  if ('error' in current) throw current.error;
  return current.plan;
}

/**
 * The search behind `planStatefulManaPayment`. `current` false runs it as it was before the gated
 * bound and the copy-free search; the verify mode and the agreement tests compare the two.
 */
export function searchPayment(
  ctx: GameContext,
  player: EnginePlayerState,
  cost: ParsedManaCost,
  allows: ManaAllowance,
  sourcesFor: (ctx: GameContext, player: EnginePlayerState) => readonly ManaSource[],
  reservedObjectIds: ReadonlySet<string>,
  lifeReserved: number,
  energyReserved: number,
  /** The bound with gated sources and the copy-free search; false is the search as it was. */
  current: boolean,
): PaymentPlan | null {
  const fixedCharacteristics = characteristicsFixedDuringPayment(definitionsInPlay(ctx));
  const premise = current && fixedCharacteristics;
  const gatedBound = premise;
  let states = 0;
  let outsideScope = false;
  // The depth bound cut a branch that still had sources to try. That is no proof the payment is
  // impossible, so it is an error only if the whole search (both phases) then finds no plan.
  let depthPruned = false;
  /** Second phase: sacrifice sources join the final payment (see `sacrificeSource`). */
  let withSacrifice = false;
  const seen = new Set<string>();
  const referenced = referencedElsewhere(ctx);
  const unsupported = (reason: string): never => {
    throw new UnmodeledCardError(
      'mana payment',
      [reason],
      'proving a changing-resource casting payment',
    );
  };
  const sources: ManaSource[] = [];
  const produced: ProducedMana[] = [];
  /** Per entry of `sources`: the life-gain orders its activation must use, if any. */
  const orders: (number[] | undefined)[] = [];
  // A capacity bound is sound only when no activation can enable another source or increase
  // production. Ignore colors, restrictions, and activation mana costs: that overestimates
  // capacity, so it can only prune an impossible payment. Phyrexian pips may use life instead.
  // A dynamic source (Exotic Orchard) changes which symbols it makes, not how many: it counts at
  // its kind's most (`ceilingUnits`). A gated source ("activate only if you control a Dragon")
  // joins the bound when its gate cannot open during the payment: open now, it is already among
  // the sources and counts at its ceiling; shut now, it stays shut and adds nothing.
  const charsOf = battlefieldCharacteristics(ctx);
  const ownCharacteristics = ctx.state.battlefield
    .filter((permanent) => permanent.controllerId === player.id)
    .map(charsOf);
  const ownAbilities = ownCharacteristics.flatMap((chars) => chars.manaAbilities);
  // "Sacrifice a creature: Add {B}{B}" (Ashnod's Altar) or "{T}, Sacrifice another creature" is a
  // fixed-capacity cost too, once nothing in play can give production back when a permanent leaves.
  // Its victim is the player's choice, so the search never makes it (see `outsideScope` below);
  // the bound only has to know that no sacrifice can make another source produce more.
  const sacrificeBound =
    ownAbilities.some((ability) => ability.costs?.some((cost) => cost.kind === 'sacrificeOther')) &&
    characteristicsFixedDuringPayment(definitionsInPlay(ctx)) &&
    leavingPermanentsKeepProduction(
      definitionsInPlay(ctx),
      ownAbilities.some((ability) => ability.condition !== undefined),
    );
  // "{T}, Sacrifice this artifact: Add one mana of any color" (Treasure, Lotus Petal) takes its own
  // permanent off the battlefield, which is no more than the other sacrifice does: nothing in play
  // gives production back when a permanent leaves, so every source still makes at most what it
  // makes now, and a Treasure counts once, at its ceiling, like any {T} source. Without this the
  // capacity bound was off for every Treasure board, and a cost seven Treasures could not pay
  // (fuzz-84: {5}{U}{R}{G}) was searched until the state budget threw. A source with no {T} cost
  // still needs the `sacrificeOther` bound (the check below), as it did. A sacrifice also changes
  // what a dynamic source reads when it reads this player's own permanents ("one color among
  // permanents you control"), so its symbols are no ceiling any more: only the kinds that read
  // the commander, an entry choice or the opponents' lands keep the bound.
  const sacrificeSelfBound =
    ownAbilities.some((ability) => ability.costs?.some((cost) => cost.kind === 'sacrificeSelf')) &&
    ownAbilities.every(
      (ability) =>
        ability.dynamic === undefined || DYNAMIC_KINDS_OUTSIDE_OWN_BOARD.has(ability.dynamic),
    ) &&
    characteristicsFixedDuringPayment(definitionsInPlay(ctx)) &&
    leavingPermanentsKeepProduction(
      definitionsInPlay(ctx),
      ownAbilities.some((ability) => ability.condition !== undefined),
    );
  const keepsCapacity = (kind: string): boolean =>
    kind === 'tap' ||
    kind === 'mana' ||
    (sacrificeBound && kind === 'sacrificeOther') ||
    (sacrificeSelfBound && kind === 'sacrificeSelf');
  const fixedCapacity = ownAbilities.every(
    (ability) =>
      ability.amount === undefined &&
      (ability.condition === undefined ||
        (gatedBound && gateCannotOpenDuringPayment(ability.condition))) &&
      (ability.costs === undefined ||
        (ability.costs.some(
          (cost) => cost.kind === 'tap' || (sacrificeBound && cost.kind === 'sacrificeOther'),
        ) &&
          ability.costs.every((cost) => keepsCapacity(cost.kind)))) &&
      (ability.onActivate ?? []).every(
        (effect) => effect.op === 'gainLife' || effect.op === 'damageController',
      ),
  );
  // Under fixed capacity no cost pays energy and the only riders gain life or deal damage to the
  // controller, so energy never changes and life rises only through a life-gain rider or a
  // damage rider from a lifelink source (with infect it gives poison, not life loss). A
  // reservation the payer cannot meet now then stays unmet in every state, and the search would
  // only try every subset of activations proving so (fuzz-11: {2}{B} and 32 life at 29 life,
  // sixteen lands, halted after a minute).
  const lifeCanRise = ownCharacteristics.some((chars) =>
    chars.manaAbilities.some((ability) =>
      (ability.onActivate ?? []).some(
        (effect) =>
          effect.op === 'gainLife' ||
          (effect.op === 'damageController' && chars.keywords.includes('lifelink')),
      ),
    ),
  );
  const productions = (source: ManaSource, activation: number): ProducedMana[][] => {
    let choices: ProducedMana[][] = [[]];
    for (const unit of source.units) {
      choices = choices.flatMap((prefix) =>
        unit
          .filter(
            (symbol) =>
              source.linked !== true || prefix.length === 0 || prefix[0]!.symbol === symbol,
          )
          .map((symbol) => [...prefix, { cardId: source.cardId, activation, symbol }]),
      );
      if (choices.length > bounds.productions) unsupported('mana symbol choice budget exceeded');
    }
    return choices;
  };
  /**
   * Replay one activation on a copy of `snapshot`. A life-gain rider may ask its controller to
   * order life-gain replacements (CR 616.1, a "plus 1" and a "twice"); every order is replayed,
   * and one copy is kept per resulting life total, least life first. The orders differ only in
   * the life gained, and more life never makes a payment fail, so a plan proven from the least
   * holds whatever order the player chooses as the payment is made: it carries no answers. A
   * higher total can pay a life cost the least cannot (Toxic Deluge after a bigger gain), so it
   * stays a branch, and a plan through it carries the answers that reach it. Any other decision
   * is outside the scope.
   */
  const runActivation = (
    snapshot: GameContext,
    single: PaymentPlan,
  ):
    | { next: GameContext; nextPlayer: EnginePlayerState; answers?: number[] }[]
    | 'outside'
    | 'unpayable' => {
    const outcomes: { next: GameContext; nextPlayer: EnginePlayerState; answers: number[] }[] = [];
    const pending: number[][] = [[]];
    let runs = 0;
    while (pending.length > 0) {
      const answers = pending.pop()!;
      if (++runs > bounds.lifeGainOrders)
        unsupported('life-gain replacement order budget exceeded');
      const next = clone(snapshot);
      const nextPlayer = next.state.players.find((p) => p.id === player.id)!;
      const activation = payManaCost(
        next,
        nextPlayer,
        emptyCost(),
        { kind: 'other' },
        [],
        reservedObjectIds,
        single,
      );
      try {
        let used = 0;
        let step = activation.next();
        while (!step.done) {
          const decision = step.value;
          if (!onlyLifeGainOrder(decision)) {
            activation.return(undefined as never);
            return 'outside';
          }
          let index: number;
          if (used < answers.length) index = answers[used]!;
          else {
            for (let other = decision.options.length - 1; other >= 1; other--)
              pending.push([...answers.slice(0, used), other]);
            answers.push(0);
            index = 0;
          }
          used += 1;
          step = activation.next({ index, targets: new Map() });
        }
      } catch (error) {
        if (error instanceof UnmodeledCardError) throw error;
        if (
          error instanceof Error &&
          (error.message === 'life cost became unpayable' ||
            error.message.endsWith("'s own mana cost became unpayable") ||
            error.message === 'engine bug: counter cost became unpayable' ||
            error.message === 'engine bug: energy cost became unpayable')
        )
          return 'unpayable';
        throw error;
      }
      if (!outcomes.some((outcome) => outcome.nextPlayer.life === nextPlayer.life))
        outcomes.push({ next, nextPlayer, answers });
    }
    outcomes.sort((a, b) => a.nextPlayer.life - b.nextPlayer.life);
    return outcomes.map((outcome, index) =>
      index === 0 ? { next: outcome.next, nextPlayer: outcome.nextPlayer } : outcome,
    );
  };
  const visit = (snapshot: GameContext): PaymentPlan | null => {
    countWork('manaPlannerStates');
    const payer = snapshot.state.players.find((p) => p.id === player.id)!;
    const availableSources = sourcesFor(snapshot, payer);
    if (
      (lifeReserved === 0 ||
        (!playerLifeLocked(snapshot, payer.id) && payer.life >= lifeReserved)) &&
      payer.energy >= energyReserved
    ) {
      const final = planPayment(
        cost,
        payer.manaEntries,
        availableSources.filter(
          (source) => source.convoke === true || (withSacrifice && sacrificeSource(source)),
        ),
        allows,
        playerLifeLocked(snapshot, payer.id) ? 0 : Math.max(0, payer.life - lifeReserved),
      );
      if (final) {
        const lifeGainOrders: Record<number, number[]> = {};
        for (const [index, answers] of orders.entries())
          if (answers !== undefined) lifeGainOrders[index] = answers;
        return {
          ...final,
          tapSources: [...sources, ...final.tapSources],
          tapCardIds: [...sources.map((s) => s.cardId), ...final.tapCardIds],
          produced: [...produced, ...final.produced],
          ...(Object.keys(lifeGainOrders).length > 0 ? { lifeGainOrders } : {}),
        };
      }
    }
    if (
      fixedCapacity &&
      (payer.energy < energyReserved ||
        (lifeReserved > 0 &&
          !lifeCanRise &&
          (playerLifeLocked(snapshot, payer.id) || payer.life < lifeReserved)))
    )
      return null;
    const key = JSON.stringify([
      snapshot.state.players.map((p) => [
        p.id,
        p.life,
        p.energy,
        p.manaEntries.map((entry) => JSON.stringify(entry)).sort(),
        p.graveyard,
        p.commandZone,
      ]),
      snapshot.state.battlefield,
      snapshot.state.exile,
    ]);
    if (seen.has(key)) return null;
    seen.add(key);
    const candidates = availableSources.filter(
      (source) => source.convoke !== true && !(withSacrifice && sacrificeSource(source)),
    );
    // Sacrifice mana is only spent in the final payment, after every replayed activation. Two
    // things the search cannot order or tell apart then stay outside its scope: a source that costs
    // mana to activate, which could need that mana first, and a permanent that has both a replayed
    // ability and a sacrifice ability (Phyrexian Tower), whose activations would share an index.
    if (
      withSacrifice &&
      candidates.some(
        (source) =>
          source.manaCost !== undefined ||
          availableSources.some(
            (other) => sacrificeSource(other) && other.cardId === source.cardId,
          ),
      )
    )
      outsideScope = true;
    const bounded = fixedCapacity && (premise || !current);
    const ceilings = bounded ? availableSources.map(ceilingUnits) : [];
    if (bounded && ceilings.every((units) => units !== null)) {
      // Alternative abilities of one permanent count at the most any one makes. A sacrifice source
      // with no {T} is different: each copy `manaSourcesFor` lists is one more creature it can
      // sacrifice, so its copies add up.
      const alternatives = new Map<string, number>();
      const repeats = new Map<string, number>();
      for (const [index, source] of availableSources.entries()) {
        const units = ceilings[index]!.length;
        if (source.sacrifices !== undefined && !source.costs.some((c) => c.kind === 'tap'))
          repeats.set(source.cardId, (repeats.get(source.cardId) ?? 0) + units);
        else alternatives.set(source.cardId, Math.max(alternatives.get(source.cardId) ?? 0, units));
      }
      const capacity =
        [...alternatives.values()].reduce((sum, count) => sum + count, 0) +
        [...repeats.values()].reduce((sum, count) => sum + count, 0);
      if (payer.manaEntries.length + capacity < totalPips(cost) - (cost.phyrexian?.length ?? 0))
        return null;
      // The same bound with colors: each source at its ceiling, a dynamic one making any type.
      // Nothing an activation does can beat that, so if the static solver cannot pay from it,
      // no order of activations can, and the search would only exhaust its budget proving so.
      if (
        (cost.phyrexian?.length ?? 0) === 0 &&
        planPayment(
          cost,
          payer.manaEntries,
          availableSources.map((source, index) => ceilingSource(source, ceilings[index]!)),
          allows,
        ) === null
      )
        return null;
    }
    if (++states > bounds.states) unsupported('mana activation state budget exceeded');
    if (sources.length >= bounds.activations) {
      if (candidates.length) depthPruned = true;
      return null;
    }
    const deduplicated = new Set<string>();
    const classKeyOf = sourceClassKeys(
      snapshot,
      availableSources,
      reservedObjectIds,
      fixedCharacteristics,
      referenced,
    );
    for (const candidate of candidates) {
      const sourceKey = classKeyOf(candidate);
      if (deduplicated.has(sourceKey)) continue;
      deduplicated.add(sourceKey);
      if (
        (candidate.stateDependentProduction && candidate.productionSpec === undefined) ||
        candidate.costs.some(
          (c) =>
            ![
              'tap',
              'mana',
              'payLife',
              'payLifeValue',
              'payEnergy',
              'removeCounters',
              'sacrificeSelf',
              'exileSelf',
            ].includes(c.kind),
        )
      ) {
        outsideScope = true;
        continue;
      }
      const source = { ...candidate, activation: sources.length };
      const { linked: _linked, ...sourceWithoutLink } = source;
      const choicesFor = (production: Pick<ManaAbilitySpec, 'units' | 'linked'>) =>
        productions(
          {
            ...sourceWithoutLink,
            units: production.units,
            ...(production.linked === true ? { linked: true as const } : {}),
          },
          source.activation,
        );
      // A source without a production spec makes exactly its own units: `payManaCost` hands the
      // probe the source itself. The probe's other outcomes (a decision, an unpayable cost, an
      // error) come from paying the costs, which the activation below repeats on its own copy
      // with the same result, so the probe and its copy of the game are skipped. If the symbol
      // choices overflow their budget, the probe still runs first, keeping the original order.
      let knownChoices: ProducedMana[][] | undefined;
      if (source.productionSpec === undefined) {
        try {
          knownChoices = choicesFor(source);
        } catch {
          knownChoices = undefined;
        }
        // With no choice the activation never runs, so only the probe could see a decision.
        if (knownChoices?.length === 0) knownChoices = undefined;
      }
      let currentProduction: Pick<ManaAbilitySpec, 'units' | 'linked'> | undefined =
        knownChoices === undefined ? undefined : source;
      const probeComplete = {};
      if (knownChoices === undefined) {
        const probe = clone(snapshot);
        const probing = payManaCost(
          probe,
          probe.state.players.find((p) => p.id === player.id)!,
          emptyCost(),
          { kind: 'other' },
          [],
          reservedObjectIds,
          {
            tapSources: [source],
            tapCardIds: [source.cardId],
            produced: [],
            fromPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
          },
          (production) => {
            currentProduction = production;
            throw probeComplete;
          },
        );
        try {
          // The probe wants only the production; a life-gain replacement order (any answer
          // gives the same production) is answered with the first option.
          let step = probing.next();
          while (!step.done && onlyLifeGainOrder(step.value))
            step = probing.next({ index: 0, targets: new Map() });
          if (!step.done) {
            outsideScope = true;
            probing.return(undefined as never);
            continue;
          }
        } catch (error) {
          if (error !== probeComplete) {
            if (
              error instanceof Error &&
              (error.message === 'life cost became unpayable' ||
                error.message.endsWith("'s own mana cost became unpayable") ||
                error.message === 'engine bug: counter cost became unpayable' ||
                error.message === 'engine bug: energy cost became unpayable')
            )
              continue;
            throw error;
          }
        }
      }
      if (currentProduction === undefined)
        throw new Error('mana production probe did not reach production');
      for (const units of unmetColorsFirst(
        knownChoices ?? choicesFor(currentProduction),
        cost,
        payer.manaEntries,
        produced,
      )) {
        const single: PaymentPlan = {
          tapSources: [source],
          tapCardIds: [source.cardId],
          produced: units,
          fromPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
        };
        const ran = runActivation(snapshot, single);
        if (ran === 'outside') {
          outsideScope = true;
          continue;
        }
        if (ran === 'unpayable') continue;
        for (const { next, nextPlayer, answers } of ran) {
          if (nextPlayer.energy < energyReserved) continue;
          sources.push(source);
          orders.push(answers);
          produced.push(...units);
          const found = visit(next);
          produced.splice(produced.length - units.length, units.length);
          orders.pop();
          sources.pop();
          if (found) return found;
        }
      }
    }
    return null;
  };
  /**
   * `visit` without a copy of the game per state. A state is the set of permanents tapped so far
   * and the pool; `visit` keys states on the whole board and pool, which for a tap-only board
   * determines the same two things, so this skips at least the states `visit` skips, each of
   * which already returned null there. Every other step (the final solve, the early exits, the
   * ceiling bound, the order and deduplication of candidates and of symbol choices, the budgets)
   * is `visit`'s own.
   */
  function searchTapOnly(): PaymentPlan | null | typeof handBack {
    if (!fixedCapacity) return handBack;
    const payer = ctx.state.players.find((p) => p.id === player.id)!;
    const rootSources = sourcesFor(ctx, payer);
    if (!rootSources.every(tapOnlySource)) return handBack;
    // A conditional amount is read after the tap, and its condition can read that tap
    // (`isUntapped`): the copying search replays it, this one does not.
    if (rootSources.some((source) => source.productionSpec?.conditionalUnits !== undefined))
      return handBack;
    const lifeLocked = playerLifeLocked(ctx, payer.id);
    const { life, energy } = payer;
    const permanentOf = new Map(ctx.state.battlefield.map((p) => [p.cardId, p]));
    const treasure = new Map<string, boolean>();
    for (const source of rootSources) {
      const perm = permanentOf.get(source.cardId);
      if (perm === undefined) return handBack;
      treasure.set(source.cardId, charsOf(perm).subtypes.includes('Treasure'));
      if (source.productionSpec !== undefined) {
        // What `payManaCost` would read after the tap: the spec resolved against a board that
        // differs only in that tap, which no dynamic kind reads.
        const production = resolveDynamicAmount(
          ctx,
          resolveDynamicUnits(ctx, resolveConditionalUnits(ctx, source.productionSpec, perm), perm),
          perm,
        );
        if (
          JSON.stringify(production.units) !== JSON.stringify(source.units) ||
          (production.linked === true) !== (source.linked === true)
        )
          return handBack;
      }
    }
    // `manaSourcesFor` ranks sources by what the untapped rest can still make, so the order
    // changes as permanents are tapped. Rebuild it the same way: tier, then board order (the
    // ranking's stable input, recovered from the root list by a stable sort), then the ranking.
    const tierOf = (cardId: string): number => {
      const types = charsOf(permanentOf.get(cardId)!).types;
      return types.includes('Land') ? 0 : types.includes('Creature') ? 2 : 1;
    };
    const boardIndex = new Map(ctx.state.battlefield.map((p, index) => [p.cardId, index]));
    const boardOrder = [...rootSources].sort(
      (a, b) =>
        tierOf(a.cardId) - tierOf(b.cardId) ||
        boardIndex.get(a.cardId)! - boardIndex.get(b.cardId)!,
    );
    let demand: ParsedManaCost[] | undefined;
    const demandOf = () => (demand ??= otherManaDemand(ctx, payer.id));
    if (
      JSON.stringify(orderByKeepValue(boardOrder, tierOf, demandOf)) !== JSON.stringify(rootSources)
    )
      return handBack;
    // The board never changes in this search but for taps, and a tapped source is gone from the
    // list, so the classes of the root listing hold at every level.
    const classKeyOf = sourceClassKeys(
      ctx,
      rootSources,
      reservedObjectIds,
      fixedCharacteristics,
      referenced,
    );
    const tapped: string[] = [];
    const pool: ManaEntry[] = [...payer.manaEntries];
    const seenStates = new Set<string>();
    let visited = 0;
    const tapOnlyVisit = (): PaymentPlan | null | typeof handBack => {
      countWork('manaPlannerStates');
      const availableSources = orderByKeepValue(
        boardOrder.filter((source) => !tapped.includes(source.cardId)),
        tierOf,
        demandOf,
      );
      if (
        (lifeReserved === 0 || (!lifeLocked && life >= lifeReserved)) &&
        energy >= energyReserved
      ) {
        const final = planPayment(
          cost,
          pool,
          [],
          allows,
          lifeLocked ? 0 : Math.max(0, life - lifeReserved),
        );
        if (final)
          return {
            ...final,
            tapSources: [...sources, ...final.tapSources],
            tapCardIds: [...sources.map((s) => s.cardId), ...final.tapCardIds],
            produced: [...produced, ...final.produced],
          };
      }
      if (
        energy < energyReserved ||
        (lifeReserved > 0 && !lifeCanRise && (lifeLocked || life < lifeReserved))
      )
        return null;
      const key = JSON.stringify([
        [...tapped].sort(),
        pool.map((entry) => JSON.stringify(entry)).sort(),
      ]);
      if (seenStates.has(key)) return null;
      seenStates.add(key);
      const ceilings = availableSources.map(ceilingUnits);
      if (ceilings.every((units) => units !== null)) {
        const remaining = new Map<string, number>();
        for (const [index, source] of availableSources.entries())
          remaining.set(
            source.cardId,
            Math.max(remaining.get(source.cardId) ?? 0, ceilings[index]!.length),
          );
        if (
          pool.length + [...remaining.values()].reduce((sum, count) => sum + count, 0) <
          totalPips(cost) - (cost.phyrexian?.length ?? 0)
        )
          return null;
        if (
          (cost.phyrexian?.length ?? 0) === 0 &&
          planPayment(
            cost,
            pool,
            availableSources.map((source, index) => ceilingSource(source, ceilings[index]!)),
            allows,
          ) === null
        )
          return null;
      }
      if (++visited > bounds.states) return handBack;
      if (sources.length >= bounds.activations) {
        if (availableSources.length) depthPruned = true;
        return null;
      }
      const deduplicated = new Set<string>();
      for (const candidate of availableSources) {
        const sourceKey = classKeyOf(candidate);
        if (deduplicated.has(sourceKey)) continue;
        deduplicated.add(sourceKey);
        const source = { ...candidate, activation: sources.length };
        let choices: ProducedMana[][];
        try {
          choices = productions(source, source.activation);
        } catch {
          return handBack;
        }
        if (choices.length === 0) return handBack;
        for (const units of unmetColorsFirst(choices, cost, pool, produced)) {
          const entries = entriesFor(source, units, treasure.get(source.cardId)!);
          tapped.push(source.cardId);
          pool.push(...entries);
          sources.push(source);
          produced.push(...units);
          const found = tapOnlyVisit();
          produced.splice(produced.length - units.length, units.length);
          sources.pop();
          pool.splice(pool.length - entries.length, entries.length);
          tapped.pop();
          if (found !== null) return found;
        }
      }
      return null;
    };
    return tapOnlyVisit();
  }

  // The same search over tapped sets instead of copied games, for a board where activating a
  // source only taps it and adds its mana (see `tapOnlySource`). It mirrors `visit` step for step
  // and gives the same plan; anything it cannot mirror exactly hands the payment back to `visit`.
  const attempt = (): PaymentPlan | null => {
    countWork('manaPlannerSearches');
    if (premise) {
      const light = searchTapOnly();
      if (light !== handBack) return light;
    }
    return visit(clone(ctx));
  };
  let result = attempt();
  // A cast that only a sacrifice can pay for stopped the search above at the sacrifice source
  // (`outsideScope`). Where nothing in play can give production back when a permanent leaves, solve
  // those sources with the final payment instead. The first search runs unchanged and comes first,
  // so a cast it could already pay is paid the same way, and no creature is sacrificed that did
  // not have to be.
  if (result === null && outsideScope && sacrificeBound) {
    states = 0;
    outsideScope = false;
    seen.clear();
    withSacrifice = true;
    result = attempt();
  }
  if (!result && depthPruned) unsupported('mana activation depth budget exceeded');
  if (!result && outsideScope)
    unsupported(
      'payment requires a static production rider or strategic activation-cost continuation outside the proven scope',
    );
  return result;
}
