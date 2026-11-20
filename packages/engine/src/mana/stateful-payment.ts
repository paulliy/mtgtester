import { copyData } from '../state/copy-data';
import { getCached, setCached } from '../effects/layer-cache';
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
import {
  resolveConditionalUnits,
  resolveDynamicAmount,
  resolveDynamicUnits,
} from '../state/queries';
import {
  characteristicsFixedDuringPayment,
  gateCannotOpenDuringPayment,
  leavingPermanentsKeepProduction,
} from './payment-stability';
import { selectedPermanentDefinition } from '../cards/spell-faces';

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
 * it. An amount counts the same way when `fixedAmount` says no activation can change it. Null for
 * production no ceiling covers: any other state-dependent amount or a rider's addition.
 */
function ceilingUnits(
  source: ManaSource,
  fixedAmount: (amount: NonNullable<ManaAbilitySpec['amount']>) => boolean,
): ManaUnit[] | null {
  if (source.stateDependentProduction !== true) return source.units;
  const spec = source.productionSpec;
  if (spec === undefined || spec.conditionalUnits !== undefined) return null;
  if (spec.amount !== undefined ? !fixedAmount(spec.amount) : spec.dynamic === undefined)
    return null;
  return source.units;
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

/** `staticSolve`'s answer when the board is not a static payment. */
const handBack = Symbol('hand back to the search');

/** How many times `needle` occurs in `text`. */
function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length))
    count++;
  return count;
}

/**
 * Classes of interchangeable permanents among `cardIds`, by card id: two permanents share a class
 * when nothing in the game can tell them apart. Their state is identical once their own ids and
 * timestamps are set aside, their definition has no static ability (whose timestamp order could
 * matter), and nothing else in the game state names either one: no effect, Aura, stack object,
 * trigger, combat assignment or choice. Activating one of them then leads to a game the same as
 * activating the other, up to which id is which, so a search that has tried one need not try the
 * other: it finds the same first plan, without the work of failing again. Thirty-six Treasures
 * are one choice instead of thirty-six (fuzz-26, fuzz-218). A permanent with no partner, or one
 * something names, has no class. The event log is history, not a reference, and is left out.
 */
export function interchangeablePermanents(
  ctx: GameContext,
  cardIds: readonly string[],
): Map<string, string> {
  const wanted = new Set(cardIds);
  const groups = new Map<string, { cardId: string; text: string; id: string }[]>();
  for (const perm of ctx.state.battlefield) {
    if (!wanted.has(perm.cardId)) continue;
    const def = ctx.defs.get(perm.oracleId);
    if (def === undefined || def.staticEffects.length > 0 || (def.ruleStatics?.length ?? 0) > 0)
      continue;
    const text = JSON.stringify(perm, (key, value: unknown) =>
      key === 'timestamp' || key === 'counterTimestamps' ? undefined : value,
    );
    const masked = text
      .split(`"${perm.id}"`)
      .join('"#self-object"')
      .split(`"${perm.cardId}"`)
      .join('"#self-card"');
    const group = groups.get(masked) ?? [];
    group.push({ cardId: perm.cardId, text, id: perm.id });
    groups.set(masked, group);
  }
  const classes = new Map<string, string>();
  let state: string | undefined;
  for (const [masked, group] of groups) {
    if (group.length < 2) continue;
    state ??= JSON.stringify({ ...ctx.state, eventLog: [], sequenceSnapshots: undefined });
    for (const member of group) {
      const unreferenced = [`"${member.id}"`, `"${member.cardId}"`].every(
        (needle) => occurrences(state!, needle) === occurrences(member.text, needle),
      );
      if (unreferenced) classes.set(member.cardId, masked);
    }
  }
  // A class needs two members: one whose partners are all referenced stands alone.
  const sizes = new Map<string, number>();
  for (const key of classes.values()) sizes.set(key, (sizes.get(key) ?? 0) + 1);
  for (const [cardId, key] of classes) if (sizes.get(key)! < 2) classes.delete(cardId);
  return classes;
}

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

/**
 * A source that pays by sacrificing itself and nothing else (a Treasure, Lotus Petal): `{T}` and
 * sacrifice-self costs only, a fixed production, no rider. Like a tap-only source, activating it
 * changes the game only by its own leaving and the pool.
 */
export function selfSacrificeSource(source: ManaSource): boolean {
  return (
    source.costs.some((cost) => cost.kind === 'sacrificeSelf') &&
    source.costs.every((cost) => cost.kind === 'tap' || cost.kind === 'sacrificeSelf') &&
    source.manaCost === undefined &&
    (source.onActivate?.length ?? 0) === 0 &&
    source.convoke !== true &&
    source.sacrifices === undefined &&
    source.taps === undefined &&
    source.resources === undefined &&
    source.stateDependentProduction !== true
  );
}

/**
 * Dynamic production that reads nothing a payer's own permanent leaving could change: the
 * opponents' lands, the commander's identity, a color chosen on entry, cards exiled with it.
 */
const BOARD_BLIND_DYNAMIC: ReadonlySet<string> = new Set([
  'opponentLandColors',
  'commanderIdentity',
  'chosenColor',
  'exiledWithSourceColors',
]);

/**
 * Every definition whose statics are in play. The capacity bound and the static solve rest
 * on activations leaving every characteristic as it is; a static that reads tapped status or life
 * breaks that ("while this is untapped, lands you control lose all abilities": tapping it gives the
 * lands their mana abilities back), and then the search copies the game with no bound at all.
 */
function definitionsInPlay(ctx: GameContext) {
  return ctx.state.battlefield.flatMap((permanent) => {
    if (permanent.faceDown) return [];
    const printed = ctx.defs.get(permanent.oracleId);
    if (printed === undefined) return [];
    return [printed, selectedPermanentDefinition(printed, permanent.face, permanent.unlockedDoors)];
  });
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
  const trace: { staticSolve?: boolean } = {};
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
      current ? trace : undefined,
    );
  if (!VERIFY_MANA_PLAN) return run(true);
  // Without the premise the current search drops the bound the old one trusted, so it may find a
  // payment the old one wrongly ruled out; there is nothing to compare against.
  if (!characteristicsFixedDuringPayment(definitionsInPlay(ctx))) return run(true);
  const legacy = outcomeOf(() => run(false));
  const current = outcomeOf(() => run(true));
  // The static solve picks its own plan; what must agree is whether the cost can be paid at all.
  // Where the old search ran out of budget it gave no answer to compare: the current one answers
  // boards it halted on (a Treasure pile, a counted amount under the bound).
  const settled = (outcome: Outcome): string =>
    'plan' in outcome
      ? outcome.plan === null
        ? 'unpayable'
        : 'payable'
      : describeOutcome(outcome);
  const [was, now] = trace.staticSolve
    ? [settled(legacy), settled(current)]
    : [describeOutcome(legacy), describeOutcome(current)];
  const legacyHalted =
    'error' in legacy &&
    legacy.error instanceof UnmodeledCardError &&
    !('error' in current && current.error instanceof UnmodeledCardError);
  if (was !== now && !legacyHalted)
    throw new Error(
      `engine bug: mana plan verification failed for ${player.id}: before ${was}, now ${now}`,
    );
  if ('error' in current) throw current.error;
  return current.plan;
}

/**
 * The search behind `planStatefulManaPayment`. `current` false runs it as it was before the gated
 * bound and the static solve; the verify mode and the agreement tests compare the two.
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
  /** The bound with gated sources and the static solve; false is the search as it was. */
  current: boolean,
  /** Set when the static solve below answered (`staticSolve`). */
  trace?: { staticSolve?: boolean },
): PaymentPlan | null {
  const premise = current && characteristicsFixedDuringPayment(definitionsInPlay(ctx));
  const gatedBound = premise;
  let states = 0;
  let outsideScope = false;
  /** Second phase: sacrifice sources join the final payment (see `sacrificeSource`). */
  let withSacrifice = false;
  /** Searched states, by the activations that were left when they were searched. */
  const seen = new Map<string, number>();
  /** The current iteration's activation limit, and whether it cut a branch short. */
  let limit = bounds.activations;
  let cut = false;
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
  const leavingBound =
    characteristicsFixedDuringPayment(definitionsInPlay(ctx)) &&
    leavingPermanentsKeepProduction(
      definitionsInPlay(ctx),
      ownAbilities.some((ability) => ability.condition !== undefined),
    );
  const sacrificeBound =
    leavingBound &&
    ownAbilities.some((ability) => ability.costs?.some((cost) => cost.kind === 'sacrificeOther'));
  // A source that sacrifices itself (a Treasure, Lotus Petal) is activated once and counted once,
  // and under the same premise its leaving gives no other source more production. Without this, one
  // Treasure on the board dropped the bound, and seven Treasures searched every order and color
  // trying to pay nine pips before the state budget halted the game (fuzz-173).
  const keepsCapacity = (kind: string): boolean =>
    kind === 'tap' ||
    kind === 'mana' ||
    (sacrificeBound && kind === 'sacrificeOther') ||
    (leavingBound && kind === 'sacrificeSelf');
  // A count of permanents ("X is the number of other creatures you control", Brigid, Doun's Mind)
  // stays what it is now when no mana ability sacrifices anything and the count does not read
  // tapped status: under the premise nothing else an activation does can enter, leave or change a
  // counted permanent. Without this one Brigid dropped the bound, and an unpayable {4}{W}{G} from
  // five sources searched every order and color until the state budget halted the game (fuzz-200).
  const nothingLeaves = !ownAbilities.some((ability) =>
    ability.costs?.some((cost) => cost.kind === 'sacrificeSelf' || cost.kind === 'sacrificeOther'),
  );
  const fixedAmount = (amount: NonNullable<ManaAbilitySpec['amount']>): boolean =>
    premise &&
    nothingLeaves &&
    amount.kind === 'countPermanents' &&
    !JSON.stringify(amount.selector).includes('"kind":"tapped"');
  const fixedCapacity = ownAbilities.every(
    (ability) =>
      (ability.amount === undefined || fixedAmount(ability.amount)) &&
      ability.conditionalUnits === undefined &&
      (ability.condition === undefined ||
        (gatedBound && gateCannotOpenDuringPayment(ability.condition))) &&
      (ability.costs === undefined ||
        (ability.costs.some(
          (cost) =>
            cost.kind === 'tap' ||
            (sacrificeBound && cost.kind === 'sacrificeOther') ||
            (leavingBound && cost.kind === 'sacrificeSelf'),
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
    // Depth-aware: a state already searched with at least as many activations left has no plan
    // within this limit. One reached before with fewer left may still have one now.
    const left = limit - sources.length;
    if ((seen.get(key) ?? -1) >= left) return null;
    seen.set(key, left);
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
    const ceilings = bounded
      ? availableSources.map((source) => ceilingUnits(source, fixedAmount))
      : [];
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
          availableSources.map((source, index) => ({ ...source, units: ceilings[index]! })),
          allows,
        ) === null
      )
        return null;
    }
    if (++states > bounds.states) unsupported('mana activation state budget exceeded');
    // The iteration's activation limit (see `attempt`): stop this branch, and note that a longer
    // plan could still exist.
    if (sources.length >= limit) {
      if (candidates.length) cut = true;
      return null;
    }
    const deduplicated = new Set<string>();
    // Only worth the state's serialization when two candidates could share a class.
    const classOf =
      candidates.length > 1
        ? interchangeablePermanents(
            snapshot,
            candidates.map((candidate) => candidate.cardId),
          )
        : new Map<string, string>();
    for (const candidate of candidates) {
      const { activation: _activation, ...signature } = candidate;
      const sourceKey = JSON.stringify(signature);
      if (deduplicated.has(sourceKey)) continue;
      deduplicated.add(sourceKey);
      // The same ability of an interchangeable permanent already tried at this step.
      const permanentClass = classOf.get(candidate.cardId);
      if (permanentClass !== undefined) {
        const { cardId: _cardId, ...ability } = signature;
        const classKey = `${permanentClass}\n${JSON.stringify(ability)}`;
        if (deduplicated.has(classKey)) continue;
        deduplicated.add(classKey);
      }
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
      for (const units of knownChoices ?? choicesFor(currentProduction)) {
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
  // The search deepens iteratively: every plan of one activation, then of two, up to
  // `bounds.activations`. A depth-first search to the full depth takes the first symbol of each
  // source first, so it paid {B} from an Exotic Orchard and four Treasures by making U, W, W, W
  // and only then B, sacrificing four Treasures, and on a board of 36 Treasures it went 32 deep
  // making W and halted over a {U} one Treasure pays (fuzz-26). The first plan found now uses the
  // fewest activations; among those, the order is the one the depth-first search used. Only a
  // payment that would still need more than `bounds.activations` activations halts.
  const attempt = (): PaymentPlan | null => {
    for (limit = 1; ; limit++) {
      cut = false;
      seen.clear();
      const result = visit(clone(ctx));
      if (result !== null || !cut) return result;
      if (limit >= bounds.activations) unsupported('mana activation depth budget exceeded');
    }
  };
  /**
   * Under the premise, a board whose every source only taps, or taps and sacrifices itself for a
   * fixed production, is the ordinary static payment: activating one changes nothing but the pool
   * and that one permanent, and nothing left reads it (`leavingBound`; a dynamic source counts
   * only when what it reads is not the payer's own board). `planPayment` solves it exactly, in the
   * keep-value order `manaSourcesFor` gives, as it does when no source on the board is dynamic.
   * Replaying the activations one by one cannot add a payment, and it branched on every color of
   * every Treasure: {4}{W}{U}{B}{R}{G} from ten Treasures halted on the state budget (fuzz-173,
   * fuzz-218).
   */
  const staticSolve = (): PaymentPlan | null | typeof handBack => {
    if (!premise || !fixedCapacity) return handBack;
    const payer = ctx.state.players.find((p) => p.id === player.id)!;
    const rootSources = sourcesFor(ctx, payer);
    if (!rootSources.every((source) => tapOnlySource(source) || selfSacrificeSource(source)))
      return handBack;
    // Tapping removes nothing; a sacrifice needs nothing in play to read the permanent leaving.
    const sacrificing = rootSources.some(selfSacrificeSource);
    if (sacrificing && !leavingBound) return handBack;
    const permanentOf = new Map(ctx.state.battlefield.map((p) => [p.cardId, p]));
    for (const source of rootSources) {
      if (source.productionSpec === undefined) continue;
      if (sacrificing && !BOARD_BLIND_DYNAMIC.has(source.productionSpec.dynamic ?? ''))
        return handBack;
      const perm = permanentOf.get(source.cardId);
      if (perm === undefined) return handBack;
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
    const lifeLocked = playerLifeLocked(ctx, payer.id);
    if (
      payer.energy < energyReserved ||
      (lifeReserved > 0 && (lifeLocked || payer.life < lifeReserved))
    )
      return null;
    if (trace) trace.staticSolve = true;
    return planPayment(
      cost,
      payer.manaEntries,
      rootSources,
      allows,
      lifeLocked ? 0 : Math.max(0, payer.life - lifeReserved),
    );
  };
  const solved = staticSolve();
  if (solved !== handBack) return solved;
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
  if (!result && outsideScope)
    unsupported(
      'payment requires a static production rider or strategic activation-cost continuation outside the proven scope',
    );
  return result;
}
