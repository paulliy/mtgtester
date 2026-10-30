import { copyData } from '../state/copy-data';
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
import { computeCharacteristics } from '../effects/continuous';
import type { ManaAbilitySpec } from '../cards/ability';
import { activationInvariantProduction } from '../cards/mana-production';
import { totalPips } from './cost';

const bounds = { states: 2048, activations: 32, productions: 256 };
/**
 * A copy to replay activations on. It leaves out the spectator snapshots and the debug log: no
 * rule reads them, and where nothing drains them (a bot game, a test) they grow with every event.
 * Logged events are appended and never edited, and a definition is replaced whole, never edited
 * (`ctx.defs.set`), so the copy shares both and owns only its log and map. Deep-copying all of it
 * made each searched state of a 58-turn fuzz game cost over a second.
 */
function clone(ctx: GameContext): GameContext {
  const { sequenceSnapshots: _snapshots, eventLog, ...state } = ctx.state;
  return {
    state: { ...copyData(state), eventLog: eventLog.slice() },
    defs: new Map(ctx.defs),
    debugLog: [],
    rng: ctx.rng.clone(),
  };
}

const ANY_TYPE: ManaUnit = ['W', 'U', 'B', 'R', 'G', 'C'];

/**
 * The most a source can produce while no activation can raise production: its units, or for a
 * dynamic source one unit of any type (five for `colorsAmongPermanents`, a unit per color). Null
 * for production no ceiling covers: a state-dependent amount or a rider's addition.
 */
function ceilingUnits(source: ManaSource): ManaUnit[] | null {
  if (source.stateDependentProduction !== true) return source.units;
  const spec = source.productionSpec;
  if (
    spec?.dynamic === undefined ||
    spec.amount !== undefined ||
    spec.conditionalUnits !== undefined
  )
    return null;
  return Array.from({ length: spec.dynamic === 'colorsAmongPermanents' ? 5 : 1 }, () => ANY_TYPE);
}

export function needsStatefulManaPayment(
  ctx: GameContext,
  player: EnginePlayerState,
  cost: ParsedManaCost,
  lifeReserved: number,
): boolean {
  const abilities = ctx.state.battlefield
    .filter((p) => p.controllerId === player.id)
    .flatMap((p) => computeCharacteristics(ctx, p).manaAbilities);
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
  let states = 0;
  let outsideScope = false;
  const seen = new Set<string>();
  const unsupported = (reason: string): never => {
    throw new UnmodeledCardError(
      'mana payment',
      [reason],
      'proving a changing-resource casting payment',
    );
  };
  const sources: ManaSource[] = [];
  const produced: ProducedMana[] = [];
  // A capacity bound is sound only when no activation can enable another source or increase
  // production. Ignore colors, restrictions, and activation mana costs: that overestimates
  // capacity, so it can only prune an impossible payment. Phyrexian pips may use life instead.
  // A dynamic source (Exotic Orchard) changes which symbols it makes, not how many: it counts at
  // its kind's most (`ceilingUnits`).
  const fixedCapacity = ctx.state.battlefield
    .filter((permanent) => permanent.controllerId === player.id)
    .flatMap((permanent) => computeCharacteristics(ctx, permanent).manaAbilities)
    .every(
      (ability) =>
        ability.amount === undefined &&
        ability.conditionalUnits === undefined &&
        ability.condition === undefined &&
        (ability.costs === undefined ||
          (ability.costs.some((cost) => cost.kind === 'tap') &&
            ability.costs.every((cost) => cost.kind === 'tap' || cost.kind === 'mana'))) &&
        (ability.onActivate ?? []).every(
          (effect) => effect.op === 'gainLife' || effect.op === 'damageController',
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
        availableSources.filter((source) => source.convoke === true),
        allows,
        playerLifeLocked(snapshot, payer.id) ? 0 : Math.max(0, payer.life - lifeReserved),
      );
      if (final)
        return {
          ...final,
          tapSources: [...sources, ...final.tapSources],
          tapCardIds: [...sources.map((s) => s.cardId), ...final.tapCardIds],
          produced: [...produced, ...final.produced],
        };
    }
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
    const candidates = availableSources.filter((source) => source.convoke !== true);
    const ceilings = fixedCapacity ? availableSources.map(ceilingUnits) : [];
    if (fixedCapacity && ceilings.every((units) => units !== null)) {
      const remaining = new Map<string, number>();
      for (const [index, source] of availableSources.entries())
        remaining.set(
          source.cardId,
          Math.max(remaining.get(source.cardId) ?? 0, ceilings[index]!.length),
        );
      if (
        payer.manaEntries.length + [...remaining.values()].reduce((sum, count) => sum + count, 0) <
        totalPips(cost) - (cost.phyrexian?.length ?? 0)
      )
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
    if (sources.length >= bounds.activations) {
      if (candidates.length) unsupported('mana activation depth budget exceeded');
      return null;
    }
    const deduplicated = new Set<string>();
    for (const candidate of candidates) {
      const { activation: _activation, ...signature } = candidate;
      const sourceKey = JSON.stringify(signature);
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
      let currentProduction: Pick<ManaAbilitySpec, 'units' | 'linked'> | undefined;
      const probeComplete = {};
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
        if (!probing.next().done) {
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
      if (currentProduction === undefined)
        throw new Error('mana production probe did not reach production');
      const { linked: _linked, ...sourceWithoutLink } = source;
      for (const units of productions(
        {
          ...sourceWithoutLink,
          units: currentProduction.units,
          ...(currentProduction.linked === true ? { linked: true as const } : {}),
        },
        source.activation,
      )) {
        const next = clone(snapshot);
        const nextPlayer = next.state.players.find((p) => p.id === player.id)!;
        const single: PaymentPlan = {
          tapSources: [source],
          tapCardIds: [source.cardId],
          produced: units,
          fromPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
        };
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
          const result = activation.next();
          if (!result.done) {
            outsideScope = true;
            activation.return(undefined as never);
            continue;
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
            continue;
          throw error;
        }
        if (nextPlayer.energy < energyReserved) continue;
        sources.push(source);
        produced.push(...units);
        const found = visit(next);
        produced.splice(produced.length - units.length, units.length);
        sources.pop();
        if (found) return found;
      }
    }
    return null;
  };
  const result = visit(clone(ctx));
  if (!result && outsideScope)
    unsupported(
      'payment requires a static production rider or strategic activation-cost continuation outside the proven scope',
    );
  return result;
}
