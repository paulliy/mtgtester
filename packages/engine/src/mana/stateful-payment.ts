import type { EnginePlayerState, GameContext } from '../state/types';
import type { ManaAllowance, ManaSource, ParsedManaCost, PaymentPlan, ProducedMana } from './cost';
import { emptyCost, planPayment } from './cost';
import { payManaCost } from '../effects/resolve';
import { UnmodeledCardError } from '../errors';
import { computeCharacteristics } from '../effects/continuous';

const bounds = { states: 2048, activations: 32, productions: 256 };
/** Copy engine data without a platform-specific cloning API; preserve aliases and array holes. */
function copyData<T>(value: T, copies = new Map<object, unknown>()): T {
  if (typeof value === 'function') throw new Error('non-data function in engine context');
  if (value === null || typeof value !== 'object') return value;
  if (copies.has(value)) return copies.get(value) as T;
  if (Array.isArray(value)) {
    const result: unknown[] = new Array(value.length);
    copies.set(value, result);
    for (const [key, entry] of Object.entries(value))
      Object.defineProperty(result, key, {
        value: copyData(entry, copies),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    return result as T;
  }
  if (value instanceof Map) {
    const result = new Map<unknown, unknown>();
    copies.set(value, result);
    for (const [key, entry] of value) result.set(copyData(key, copies), copyData(entry, copies));
    return result as T;
  }
  if (value instanceof Set) {
    const result = new Set<unknown>();
    copies.set(value, result);
    for (const entry of value) result.add(copyData(entry, copies));
    return result as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('non-data object in engine context');
  const result: Record<string, unknown> = Object.create(prototype);
  copies.set(value, result);
  for (const [key, entry] of Object.entries(value))
    Object.defineProperty(result, key, {
      value: copyData(entry, copies),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  return result as T;
}
function clone(ctx: GameContext): GameContext {
  const copied = copyData({ state: ctx.state, defs: ctx.defs, debugLog: ctx.debugLog });
  return {
    ...copied,
    rng: ctx.rng.clone(),
  };
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
    abilities.some((a) => (a.onActivate?.length ?? 0) > 0) &&
    (lifeReserved > 0 ||
      (cost.phyrexian?.length ?? 0) > 0 ||
      abilities.some((a) =>
        a.costs?.some((c) => ['payLife', 'payLifeValue', 'removeCounters'].includes(c.kind)),
      ))
  );
}

/** Actual activation replay for fixed-production sources with no strategic cost decisions. */
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
    if (++states > bounds.states) unsupported('mana activation state budget exceeded');
    const payer = snapshot.state.players.find((p) => p.id === player.id)!;
    if ((lifeReserved === 0 || payer.life >= lifeReserved) && payer.energy >= energyReserved) {
      const final = planPayment(
        cost,
        payer.manaEntries,
        [],
        allows,
        Math.max(0, payer.life - lifeReserved),
      );
      if (final)
        return {
          ...final,
          tapSources: [...sources],
          tapCardIds: sources.map((s) => s.cardId),
          produced: [...produced],
        };
    }
    const key = JSON.stringify([
      snapshot.state.players.map((p) => [
        p.id,
        p.life,
        p.energy,
        p.manaEntries,
        p.graveyard,
        p.commandZone,
      ]),
      snapshot.state.battlefield,
      snapshot.state.exile,
    ]);
    if (seen.has(key)) return null;
    seen.add(key);
    const candidates = sourcesFor(snapshot, payer);
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
        candidate.stateDependentProduction ||
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
      for (const units of productions(source, source.activation)) {
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
      'payment requires state-dependent production or strategic activation-cost continuation outside the proven scope',
    );
  return result;
}
