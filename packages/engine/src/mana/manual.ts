/**
 * Activating a mana ability by hand (CR 605.3a): a player with priority may activate one, and
 * its mana goes to their pool, where the next payment spends it before tapping anything else
 * (`planPayment` prefers pool mana).
 *
 * The engine still auto-pays every cost (ADR 0003 decision 4); this only lets a player who asked
 * for it (`EnginePlayerState.manualMana`, set for human seats) choose which permanents make the
 * mana first. Bots never see these options. See ADR 0030.
 *
 * Offered for the sources the payment solver itself activates, with the same costs, riders,
 * restrictions and triggers, because applying one runs `payManaCost` with a one-source plan. A
 * source is left out when its production is only known after its costs are paid (it has a
 * `productionSpec` or state-dependent production), or when it can make more than
 * `MAX_OUTCOMES` different sets of mana; auto-pay still uses those.
 */

import type { Color, PlayerId } from '@mtg/shared';
import type { EngineActionOption } from '../decisions';
import { manaSourcesFor } from '../state/queries';
import type { EnginePlayerState, GameContext } from '../state/types';
import { sacrificesArePayable, type ManaSource, type PaymentPlan } from './cost';
import { emptyPool, selectEntriesToSpend } from './pool';

/** A choice set larger than this ("two mana in any combination of colors") is not offered. */
const MAX_OUTCOMES = 10;

/** One manual activation: which source, which of its abilities, and the mana it makes. */
export interface ActivateManaAbilityPayload {
  kind: 'activateManaAbility';
  cardId: string;
  /**
   * Which of the card's mana abilities, as its position among `manaSourcesFor`'s sources with
   * this card id (a painland's {C} is 0, its {W}-or-{U} is 1). `ManaSource.activation` cannot
   * say: alternatives on one permanent usually leave it unset.
   */
  ability: number;
  symbols: (Color | 'C')[];
}

/** `manaSourcesFor`'s sources, each with its position among the sources of the same card. */
function numberedSources(
  ctx: GameContext,
  playerId: PlayerId,
): { source: ManaSource; ability: number }[] {
  const seen = new Map<string, number>();
  return manaSourcesFor(ctx, playerId).map((source) => {
    const ability = seen.get(source.cardId) ?? 0;
    seen.set(source.cardId, ability + 1);
    return { source, ability };
  });
}

/** Each distinct set of mana `source` can make, in a stable order; null when too many. */
function outcomesFor(source: ManaSource): (Color | 'C')[][] | null {
  const seen = new Set<string>();
  const outcomes: (Color | 'C')[][] = [];
  const walk = (index: number, chosen: (Color | 'C')[]): boolean => {
    if (index === source.units.length) {
      if (source.linked === true && chosen.some((symbol) => symbol !== chosen[0])) return true;
      const key = [...chosen].sort().join('');
      if (seen.has(key)) return true;
      seen.add(key);
      outcomes.push([...chosen]);
      return outcomes.length <= MAX_OUTCOMES;
    }
    for (const symbol of source.units[index]!) {
      if (!walk(index + 1, [...chosen, symbol])) return false;
    }
    return true;
  };
  return walk(0, []) && outcomes.length > 0 ? outcomes : null;
}

/** Can this one activation's own costs be paid right now, on their own? */
function activatable(ctx: GameContext, player: EnginePlayerState, source: ManaSource): boolean {
  if (source.productionSpec !== undefined || source.stateDependentProduction === true) return false;
  if ((source.resources ?? []).some((resource) => resource.available < resource.amount)) {
    return false;
  }
  if (!sacrificesArePayable(source.sacrifices ?? [], new Set([source.cardId]))) return false;
  const untapped = new Set(ctx.state.battlefield.filter((p) => !p.tapped).map((p) => p.cardId));
  const taps = (source.taps ?? []).map((group) => group.filter((id) => untapped.has(id)));
  if (!sacrificesArePayable(taps, new Set([source.cardId]))) return false;
  if (source.manaCost !== undefined) {
    const unrestricted = player.manaEntries.filter((entry) => entry.restriction === undefined);
    if (selectEntriesToSpend(unrestricted, source.manaCost) === null) return false;
  }
  return true;
}

function describeSymbols(symbols: readonly (Color | 'C')[]): string {
  return symbols.map((symbol) => `{${symbol}}`).join('');
}

/** The manual mana activations `player` may choose at this priority window. */
export function manualManaOptions(
  ctx: GameContext,
  player: EnginePlayerState,
): EngineActionOption[] {
  const options: EngineActionOption[] = [];
  for (const { source, ability } of numberedSources(ctx, player.id)) {
    const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
    if (perm === undefined || !activatable(ctx, player, source)) continue;
    const outcomes = outcomesFor(source);
    if (outcomes === null) continue;
    for (const symbols of outcomes) {
      const payload: ActivateManaAbilityPayload = {
        kind: 'activateManaAbility',
        cardId: source.cardId,
        ability,
        symbols,
      };
      options.push({
        type: 'activateManaAbility',
        description: `${perm.name}: add ${describeSymbols(symbols)}`,
        payload,
        data: { sourceName: perm.name, symbols, abilityCosts: source.costs },
        interaction: { kind: 'source', sourceId: perm.id, sourceCardId: perm.cardId },
      });
    }
  }
  return options;
}

/**
 * The one-source plan that applying `payload` executes, re-derived from the current board so a
 * stale or forged choice fails instead of making mana the source cannot make.
 */
export function manualManaPlan(
  ctx: GameContext,
  playerId: PlayerId,
  player: EnginePlayerState,
  payload: ActivateManaAbilityPayload,
): PaymentPlan {
  const source = numberedSources(ctx, playerId).find(
    (candidate) =>
      candidate.source.cardId === payload.cardId && candidate.ability === payload.ability,
  )?.source;
  if (source === undefined || !activatable(ctx, player, source)) {
    throw new Error('illegal action: that mana ability cannot be activated now');
  }
  const key = [...payload.symbols].sort().join('');
  if (!(outcomesFor(source) ?? []).some((outcome) => [...outcome].sort().join('') === key)) {
    throw new Error('illegal action: that mana ability cannot make that mana');
  }
  return {
    tapCardIds: [source.cardId],
    tapSources: [source],
    fromPool: emptyPool(),
    produced: payload.symbols.map((symbol) => ({
      cardId: source.cardId,
      ...(source.activation !== undefined ? { activation: source.activation } : {}),
      symbol,
    })),
  };
}
