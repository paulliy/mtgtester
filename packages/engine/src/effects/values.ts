/**
 * Resolution-time `Value` evaluation — the half that reads *current* characteristics.
 *
 * Separate from `cards/value.ts` on purpose: this module calls `selectPermanents` and
 * `effectivePT`, both of which run the CR 613 layer pass. That is safe here because effects
 * resolve after the pass has finished, and unsafe inside the pass itself, which is why the
 * layer engine keeps its own narrower evaluator. See the comment in `cards/value.ts`.
 */

import type { Value, ValueScope } from '../cards/value';
import { cardTypesInAllGraveyards, devotionTo } from '../cards/value';
import type { Selector } from '../cards/selector';
import type { EnginePermanent, GameContext } from '../state/types';
import { computeCharacteristics, selectPermanents } from './continuous';
import { effectivePT, getDefByOracleId } from '../state/queries';
import { spellManaValue } from '../state/objects';

function scopedPermanents(
  ctx: GameContext,
  scope: ValueScope,
  selector: Selector,
  who: 'you' | 'opponents' | 'all',
): EnginePermanent[] {
  const source = { cardId: scope.sourceCardId ?? '', controllerId: scope.controllerId };
  return selectPermanents(ctx, selector, source).filter((perm) => {
    if (who === 'you') return perm.controllerId === scope.controllerId;
    if (who === 'opponents') return perm.controllerId !== scope.controllerId;
    return true;
  });
}

/** Evaluate any `Value` in the context of a resolving spell or ability. */
export function evaluateValueIn(ctx: GameContext, value: Value, scope: ValueScope): number {
  switch (value.kind) {
    case 'const':
      return value.n;
    case 'plus':
      return evaluateValueIn(ctx, value.of, scope) + value.n;
    case 'times':
      return evaluateValueIn(ctx, value.of, scope) * value.n;
    case 'cardTypesInAllGraveyards':
      return cardTypesInAllGraveyards(ctx);
    case 'countPermanents':
      return scopedPermanents(ctx, scope, value.selector, value.scope).length;
    case 'colorsAmongPermanents': {
      const colors = new Set<string>();
      for (const perm of ctx.state.battlefield) {
        if (perm.controllerId !== scope.controllerId) continue;
        for (const color of computeCharacteristics(ctx, perm).colors) colors.add(color);
      }
      return colors.size;
    }
    case 'devotionTo':
      return devotionTo(ctx, scope.controllerId, value.color);
    case 'countOpponents':
      return ctx.state.players.filter((player) => player.id !== scope.controllerId).length;
    case 'greatestToughnessAmong':
      return scopedPermanents(ctx, scope, value.selector, value.scope).reduce(
        (best, perm) => Math.max(best, effectivePT(ctx, perm).toughness),
        0,
      );
    case 'greatestPowerAmong':
      return scopedPermanents(ctx, scope, value.selector, value.scope).reduce(
        (best, perm) => Math.max(best, effectivePT(ctx, perm).power),
        0,
      );
    case 'greatestManaValueAmong':
      return scopedPermanents(ctx, scope, value.selector, value.scope).reduce(
        (best, perm) => Math.max(best, spellManaValue(getDefByOracleId(ctx, perm.oracleId, perm.name), undefined)),
        0,
      );
    case 'totalPowerOfAttackers':
      return ctx.state.battlefield
        .filter((perm) => perm.attacking !== null)
        .reduce((total, perm) => total + effectivePT(ctx, perm).power, 0);
    case 'xValue':
      // A spell announced with no X is X=0 (CR 601.2b), which is a legal announcement.
      return scope.x ?? 0;
    case 'damageDealt':
      return scope.damageDealt ?? 0;
    case 'triggerCount':
      // An aggregate trigger always fired because at least one object matched, so the absent
      // case is a scope that was never populated — 1 is the honest floor, not 0.
      return scope.triggerCount ?? 1;
    case 'spellManaValue':
      return scope.spellManaValue ?? 0;
    case 'manaSpent':
      return scope.manaSpent ?? 0;
    case 'treasureManaSpent':
      return scope.treasureManaSpent ?? 0;
    case 'energyPaid':
      return scope.energyPaid ?? 0;
    case 'energyAvailable':
      return ctx.state.players.find((p) => p.id === scope.controllerId)?.energy ?? 0;
    case 'stationPower':
      return scope.stationPower ?? 0;
    case 'countersOnSelf': {
      if (!scope.sourceCardId) return 0;
      const perm = ctx.state.battlefield.find((p) => p.cardId === scope.sourceCardId);
      return perm ? (perm.counters[value.counter] ?? 0) : 0;
    }
    case 'countersOnTarget': {
      if (value.target === 'triggerObject') {
        if (!scope.triggerObjectCardId) return 0;
        const perm = ctx.state.battlefield.find((p) => p.cardId === scope.triggerObjectCardId);
        return perm ? (perm.counters[value.counter] ?? 0) : 0;
      }
      const targetId = typeof value.target === 'number' ? scope.targets?.[value.target] : undefined;
      if (!targetId) return 0;
      const perm = ctx.state.battlefield.find((p) => p.id === targetId || p.cardId === targetId);
      return perm ? (perm.counters[value.counter] ?? 0) : 0;
    }
    case 'manaValueOfTarget': {
      const targetId =
        value.target === 'triggerObject'
          ? scope.triggerObjectCardId
          : typeof value.target === 'number'
            ? scope.targets?.[value.target]
            : undefined;
      if (!targetId) return 0;
      const perm = ctx.state.battlefield.find((p) => p.id === targetId || p.cardId === targetId);
      if (perm === undefined) return 0;
      return spellManaValue(getDefByOracleId(ctx, perm.oracleId, perm.name), undefined);
    }
    case 'commanderCastCount': {
      const player = ctx.state.players.find((p) => p.id === scope.controllerId);
      if (!player || !player.commanderCastCount) return 0;
      return Object.values(player.commanderCastCount).reduce((sum, n) => sum + n, 0);
    }
    case 'lifeTotal': {
      const targetPlayerId = value.scope === 'you' ? scope.controllerId : (scope.eventPlayerId ?? scope.controllerId);
      const player = ctx.state.players.find((p) => p.id === targetPlayerId);
      return player ? player.life : 0;
    }
    case 'countOpponentsWithFewerCreatures': {
      const myCreatures = scopedPermanents(ctx, scope, { kind: 'type', value: 'Creature' }, 'you').length;
      let count = 0;
      for (const p of ctx.state.players) {
        if (p.id !== scope.controllerId) {
          const oppCreatures = scopedPermanents(ctx, { ...scope, controllerId: p.id }, { kind: 'type', value: 'Creature' }, 'you').length;
          if (oppCreatures < myCreatures) count++;
        }
      }
      return count;
    }
    case 'creaturesDiedThisTurn':
      return ctx.state.creaturesDiedThisTurn;
    case 'powerOfSource': {
      const perm = ctx.state.battlefield.find((p) => p.cardId === scope.sourceCardId);
      return perm === undefined ? 0 : effectivePT(ctx, perm).power;
    }
    case 'toughnessOfSource': {
      const perm = ctx.state.battlefield.find((p) => p.cardId === scope.sourceCardId);
      return perm === undefined ? 0 : effectivePT(ctx, perm).toughness;
    }
    case 'opponentsLostLifeThisTurn':
      return ctx.state.players.filter(
        (player) => player.id !== scope.controllerId && ctx.state.lifeLostThisTurn[player.id] === true,
      ).length;
    case 'powerOfTriggerObject': {
      const perm = scope.triggerObjectCardId === undefined
        ? undefined
        : ctx.state.battlefield.find((p) => p.cardId === scope.triggerObjectCardId);
      return perm === undefined ? 0 : effectivePT(ctx, perm).power;
    }
    case 'cardsInTargetHand': {
      const targetId =
        typeof value.target === 'number' ? scope.targets?.[value.target] : undefined;
      return ctx.state.players.find((player) => player.id === targetId)?.hand.length ?? 0;
    }
    case 'tappedCreaturesControlledByTarget': {
      const targetId =
        typeof value.target === 'number' ? scope.targets?.[value.target] : undefined;
      if (targetId === undefined) return 0;
      return ctx.state.battlefield.filter(
        (permanent) =>
          permanent.controllerId === targetId &&
          permanent.tapped &&
          computeCharacteristics(ctx, permanent).types.includes('Creature'),
      ).length;
    }
    case 'attackingCreatures':
      return ctx.state.battlefield.filter((permanent) => permanent.attacking !== null).length;
    case 'spellsCastThisTurn':
      return ctx.state.players.find((player) => player.id === scope.controllerId)?.spellsCastThisTurn ?? 0;
    case 'countersOnTriggerObject': {
      const object = scope.triggerObjectCardId === undefined
        ? undefined
        : ctx.state.battlefield.find((p) => p.cardId === scope.triggerObjectCardId) ??
          ctx.state.players.flatMap((p) => p.graveyard).find((c) => c.cardId === scope.triggerObjectCardId);
      if (object === undefined) return 0;
      return 'counters' in object
        ? (object.counters[value.counter] ?? 0)
        : (object.rememberedCounters?.[value.counter] ?? 0);
    }
  }
}
