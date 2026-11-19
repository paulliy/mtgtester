import type { AbilityCost } from '../cards/definition';
import { computeCharacteristics, matchesSelector } from '../effects/continuous';
import {
  allowanceFor,
  manaSourcesFor,
  sacrificeCandidateAllowed,
  selfMayTap,
} from '../state/queries';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../state/types';
import { planPayment, type ManaSource, type ParsedManaCost } from './cost';

/**
 * The mana sources a payment may use when `reserved` permanents are spoken for by another part
 * of the same cost (Ashnod's Altar paying for Canoptek Wraith's "{3} and sacrifice it" may not
 * sacrifice the Wraith). A reserved permanent leaves every source's sacrifice candidates, a
 * source left with no candidate for one of its sacrifices is dropped, and a source that would
 * sacrifice a reserved permanent itself is dropped. The planner then keeps the sacrifices
 * distinct (`sacrificesArePayable`).
 */
export function withoutReserved(
  ctx: GameContext,
  sources: readonly ManaSource[],
  reserved: ReadonlySet<string>,
): ManaSource[] {
  if (reserved.size === 0) return [...sources];
  const reservedCards = new Set(
    ctx.state.battlefield.filter((p) => reserved.has(p.id)).map((p) => p.cardId),
  );
  return sources.flatMap((source) => {
    if (
      reservedCards.has(source.cardId) &&
      source.costs.some((cost) => cost.kind === 'sacrificeSelf')
    ) {
      return [];
    }
    if (source.sacrifices === undefined) return [source];
    const sacrifices = source.sacrifices.map((group) =>
      group.filter((id) => !reservedCards.has(id)),
    );
    return sacrifices.some((group) => group.length === 0) ? [] : [{ ...source, sacrifices }];
  });
}

interface ActivationPlan {
  /** Mana sources the payment may use once the tap and sacrifice costs are assigned. */
  sources: ReturnType<typeof manaSourcesFor>;
  /** Object ids the ability's own sacrifice costs take; no mana ability may use them. */
  reservedForSacrifice: ReadonlySet<string>;
}

/**
 * Find one assignment of an activated ability's tap and sacrifice costs to distinct permanents
 * that still leaves `mana` payable. A mana source that sacrifices something (Illuminor Szeras,
 * Ashnod's Altar) must not take a permanent the ability's own sacrifice needs, so the sacrifices
 * are reserved before the mana solver runs, exactly as the payment will reserve them.
 */
function planActivation(
  ctx: GameContext,
  player: EnginePlayerState,
  source: EnginePermanent,
  costs: readonly AbilityCost[],
  mana: ParsedManaCost,
  x: number,
  unavailable: readonly string[],
): ActivationPlan | null {
  // A cost that takes cards from the hand (Pack Rat's discard) is paid before the mana here, so a
  // hand mana source (Simian Spirit Guide) could be that card or leave too few to pay it. Fail
  // closed: such an activation is priced and paid from the board alone.
  const takesFromHand = costs.some(
    (c) => c.kind === 'discardCard' || c.kind === 'discardHand' || c.kind === 'exileCardFromHand',
  );
  const sources = manaSourcesFor(ctx, player.id).filter(
    (s) => !takesFromHand || s.fromHand !== true,
  );
  const excluded = new Set(unavailable);
  if (costs.some((c) => c.kind === 'tap' || c.kind === 'sacrificeSelf' || c.kind === 'exileSelf'))
    excluded.add(source.cardId);
  const taps = costs.filter((c) =>
    ['tapOther', 'tapOthers', 'tapXOthers', 'tapCreaturesTotalPower'].includes(c.kind),
  );
  const sacrifices = costs.filter(
    (c): c is Extract<AbilityCost, { kind: 'sacrificeOther' }> => c.kind === 'sacrificeOther',
  );
  const tapCandidates = ctx.state.battlefield.filter(
    (p) => p.controllerId === player.id && !p.tapped,
  );
  const allows = allowanceFor(ctx, player.id, {
    kind: 'activateAbility',
    sourceOracleId: source.oracleId,
  });
  const scope = { cardId: source.cardId, controllerId: player.id };
  const reserved = new Set<string>();

  function leaf(): ActivationPlan | null {
    // A mana source's own tap cost (Springleaf Drum) may not tap a permanent the ability's tap
    // costs already take.
    const usable = withoutReserved(
      ctx,
      sources.flatMap((s) => {
        if (excluded.has(s.cardId)) return [];
        if (s.taps === undefined) return [s];
        const taps = s.taps.map((group) => group.filter((id) => !excluded.has(id)));
        return taps.some((group) => group.length === 0) ? [] : [{ ...s, taps }];
      }),
      reserved,
    );
    return planPayment(mana, player.manaEntries, usable, allows, player.life) === null
      ? null
      : { sources: usable, reservedForSacrifice: new Set(reserved) };
  }

  // Sacrifices come after taps. A permanent tapped for one cost may still be sacrificed for
  // another, and `unavailable` (the source and a candidate being tapped) only keeps permanents
  // away from the mana payment and the tap costs; each sacrifice takes a distinct permanent.
  function visitSacrifice(index: number): ActivationPlan | null {
    const cost = sacrifices[index];
    if (cost === undefined) return leaf();
    const options = ctx.state.battlefield.filter(
      (p) =>
        p.controllerId === player.id &&
        !reserved.has(p.id) &&
        sacrificeCandidateAllowed(ctx, cost, source, p) &&
        matchesSelector(ctx, p, cost.selector, scope),
    );
    function choose(start: number, remaining: number): ActivationPlan | null {
      if (remaining <= 0) return visitSacrifice(index + 1);
      for (let i = start; i < options.length; i++) {
        const p = options[i]!;
        reserved.add(p.id);
        const result = choose(i + 1, remaining - 1);
        reserved.delete(p.id);
        if (result !== null) return result;
      }
      return null;
    }
    return choose(0, cost.count ?? 1);
  }

  function visitTap(index: number): ActivationPlan | null {
    const cost = taps[index];
    if (cost === undefined) return visitSacrifice(0);
    const crew = cost.kind === 'tapCreaturesTotalPower';
    const required =
      cost.kind === 'tapOthers'
        ? cost.count
        : cost.kind === 'tapXOthers'
          ? x
          : crew
            ? cost.minPower
            : 1;
    const options = tapCandidates.filter(
      (p) =>
        !excluded.has(p.cardId) &&
        (p.id !== source.id || selfMayTap(cost, costs)) &&
        (crew
          ? computeCharacteristics(ctx, p).types.includes('Creature')
          : 'selector' in cost && matchesSelector(ctx, p, cost.selector, scope)),
    );
    function choose(start: number, remaining: number): ActivationPlan | null {
      if (remaining <= 0) return visitTap(index + 1);
      for (let i = start; i < options.length; i++) {
        const p = options[i]!;
        const value = crew ? Math.max(0, computeCharacteristics(ctx, p).power ?? 0) : 1;
        if (value === 0) continue;
        excluded.add(p.cardId);
        const result = choose(i + 1, remaining - value);
        excluded.delete(p.cardId);
        if (result !== null) return result;
      }
      return null;
    }
    return choose(0, required);
  }
  return visitTap(0);
}

/** Reserve distinct permanents for tap costs before asking the mana solver to spend them. */
export function activationManaSources(
  ctx: GameContext,
  player: EnginePlayerState,
  source: EnginePermanent,
  costs: readonly AbilityCost[],
  mana: ParsedManaCost,
  x = 0,
  unavailable: readonly string[] = [],
): ReturnType<typeof manaSourcesFor> | null {
  return planActivation(ctx, player, source, costs, mana, x, unavailable)?.sources ?? null;
}

/**
 * The permanents to keep away from the mana payment so the ability's own sacrifice cost can
 * still be paid after it — the reservation `activationManaSources` priced the activation with.
 */
export function activationSacrificeReservation(
  ctx: GameContext,
  player: EnginePlayerState,
  source: EnginePermanent,
  costs: readonly AbilityCost[],
  mana: ParsedManaCost,
  x = 0,
): ReadonlySet<string> | null {
  return planActivation(ctx, player, source, costs, mana, x, [])?.reservedForSacrifice ?? null;
}
