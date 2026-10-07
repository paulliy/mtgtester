import { eventObjectFacts, sourceObjectFacts } from '../cards/source-identity';
import { counterCount } from '../state/counters';
import { assertNever } from '../utils/assert-never';
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
import { selectMatches } from '../cards/selector';
import type { EnginePermanent, GameContext } from '../state/types';
import { computeCharacteristics, selectPermanents } from './continuous';
import { cardZoneCandidate, effectivePT, getDefByOracleId, opponentsOf } from '../state/queries';
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
    case 'negate':
      return -evaluateValueIn(ctx, value.of, scope);
    case 'times':
      return evaluateValueIn(ctx, value.of, scope) * value.n;
    case 'cardTypesInAllGraveyards':
      return cardTypesInAllGraveyards(ctx);
    case 'countPermanents':
      return scopedPermanents(ctx, scope, value.selector, value.scope).length;
    case 'countTappedPermanents':
      return scopedPermanents(ctx, scope, value.selector, value.scope).filter(
        (permanent) => permanent.tapped,
      ).length;
    case 'countPermanentsControlledByTarget': {
      const targetId = typeof value.target === 'number' ? scope.targets?.[value.target] : undefined;
      if (targetId === undefined) return 0;
      const source = { cardId: scope.sourceCardId ?? '', controllerId: scope.controllerId };
      return selectPermanents(ctx, value.selector, source).filter(
        (permanent) => permanent.controllerId === targetId,
      ).length;
    }
    case 'aurasYouControlAttachedToCreatures':
      return ctx.state.battlefield.filter((permanent) => {
        if (permanent.controllerId !== scope.controllerId || permanent.attachedTo === null) {
          return false;
        }
        if (!computeCharacteristics(ctx, permanent).subtypes.includes('Aura')) return false;
        const attached = ctx.state.battlefield.find(
          (candidate) => candidate.id === permanent.attachedTo,
        );
        return (
          attached !== undefined && computeCharacteristics(ctx, attached).types.includes('Creature')
        );
      }).length;
    case 'countCardsInZone': {
      const source = { cardId: scope.sourceCardId ?? '', controllerId: scope.controllerId };
      let count = 0;
      for (const player of ctx.state.players) {
        if (player.hasLost) continue;
        if (value.owner === 'you' && player.id !== scope.controllerId) continue;
        if (value.owner === 'opponents' && player.id === scope.controllerId) continue;
        for (const card of player[value.zone]) {
          if (selectMatches(cardZoneCandidate(ctx, card, player.id), value.selector, source)) {
            count++;
          }
        }
      }
      return count;
    }
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
      // Opponents still in the game (CR 102.2/800.4a) — an eliminated player is no one's opponent.
      return opponentsOf(ctx, scope.controllerId).length;
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
        (best, perm) =>
          Math.max(
            best,
            spellManaValue(getDefByOracleId(ctx, perm.oracleId, perm.name), undefined),
          ),
        0,
      );
    case 'totalPowerAmong':
      return scopedPermanents(ctx, scope, value.selector, value.scope).reduce(
        (total, perm) => total + effectivePT(ctx, perm).power,
        0,
      );
    case 'totalPowerOfAttackers':
      return ctx.state.battlefield
        .filter((perm) => perm.attacking !== null)
        .reduce((total, perm) => total + effectivePT(ctx, perm).power, 0);
    case 'xValue':
      // A spell announced with no X is X=0 (CR 601.2b), which is a legal announcement.
      return scope.x ?? 0;
    case 'optionalCostCount': {
      const resolving = scope.resolvingOptionalCostCounts?.[value.mechanic];
      if (resolving !== undefined) return resolving;
      const permanent = ctx.state.battlefield.find(
        (candidate) => candidate.cardId === scope.sourceCardId,
      );
      const stackObject = ctx.state.stack.find(
        (candidate) => candidate.sourceCardId === scope.sourceCardId,
      );
      return (
        permanent?.optionalCostCounts?.[value.mechanic] ??
        stackObject?.optionalCostCounts?.[value.mechanic] ??
        0
      );
    }
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
      const facts = sourceObjectFacts(ctx, scope);
      return facts === undefined ? 0 : counterCount(facts.counters, value.counter);
    }
    case 'allCountersOnSelf': {
      const facts = sourceObjectFacts(ctx, scope);
      return facts
        ? Object.values(facts.counters).reduce((total, count) => total + count, 0)
        : (scope.sourceCountersTotal ?? 0);
    }
    case 'countersOnTarget': {
      if (value.target === 'source') {
        const facts = sourceObjectFacts(ctx, scope);
        return facts === undefined ? 0 : counterCount(facts.counters, value.counter);
      }
      if (value.target === 'triggerObject') {
        const facts = eventObjectFacts(ctx, scope);
        return facts === undefined ? 0 : counterCount(facts.counters, value.counter);
      }
      const targetId = typeof value.target === 'number' ? scope.targets?.[value.target] : undefined;
      if (!targetId) return 0;
      const perm = ctx.state.battlefield.find((p) => p.id === targetId || p.cardId === targetId);
      return perm ? counterCount(perm.counters, value.counter) : 0;
    }
    case 'manaValueOfTarget': {
      if (value.target === 'source')
        return sourceObjectFacts(ctx, scope)?.manaValue ?? scope.resolvingSourceManaValue ?? 0;
      if (value.target === 'triggerObject') return eventObjectFacts(ctx, scope)?.manaValue ?? 0;
      const targetId = typeof value.target === 'number' ? scope.targets?.[value.target] : undefined;
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
    case 'commanderIdentityColorCount': {
      const player = ctx.state.players.find((p) => p.id === scope.controllerId);
      return player?.commanderColorIdentity.length ?? 0;
    }
    case 'lifeTotal': {
      const targetPlayerId =
        value.scope === 'you' ? scope.controllerId : (scope.eventPlayerId ?? scope.controllerId);
      const player = ctx.state.players.find((p) => p.id === targetPlayerId);
      return player ? player.life : 0;
    }
    case 'countOpponentsWithFewerCreatures': {
      const myCreatures = scopedPermanents(
        ctx,
        scope,
        { kind: 'type', value: 'Creature' },
        'you',
      ).length;
      // Only players still in the game are opponents (CR 800.4a); an eliminated player with no
      // creatures left must not count as one who controls fewer.
      let count = 0;
      for (const p of opponentsOf(ctx, scope.controllerId)) {
        const oppCreatures = scopedPermanents(
          ctx,
          { ...scope, controllerId: p.id },
          { kind: 'type', value: 'Creature' },
          'you',
        ).length;
        if (oppCreatures < myCreatures) count++;
      }
      return count;
    }
    case 'creaturesDiedThisTurn':
      return ctx.state.creaturesDiedThisTurn;
    case 'powerOfSource':
      return sourceObjectFacts(ctx, scope)?.power ?? 0;
    case 'toughnessOfSource':
      return sourceObjectFacts(ctx, scope)?.toughness ?? 0;
    case 'powerOfTarget': {
      if (value.target === 'source') return sourceObjectFacts(ctx, scope)?.power ?? 0;
      if (value.target === 'triggerObject') return eventObjectFacts(ctx, scope)?.power ?? 0;
      const targetId = typeof value.target === 'number' ? scope.targets?.[value.target] : undefined;
      if (targetId === undefined) return 0;
      const permanent = ctx.state.battlefield.find(
        (candidate) => candidate.id === targetId || candidate.cardId === targetId,
      );
      return permanent === undefined ? 0 : effectivePT(ctx, permanent).power;
    }
    case 'opponentsLostLifeThisTurn':
      return opponentsOf(ctx, scope.controllerId).filter(
        (player) => ctx.state.lifeLostThisTurn[player.id] === true,
      ).length;
    case 'powerOfTriggerObject':
      return eventObjectFacts(ctx, scope)?.power ?? 0;
    case 'cardsInTargetHand': {
      const targetId = typeof value.target === 'number' ? scope.targets?.[value.target] : undefined;
      return ctx.state.players.find((player) => player.id === targetId)?.hand.length ?? 0;
    }
    case 'tappedCreaturesControlledByTarget': {
      const targetId = typeof value.target === 'number' ? scope.targets?.[value.target] : undefined;
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
      return (
        ctx.state.players.find((player) => player.id === scope.controllerId)?.spellsCastThisTurn ??
        0
      );
    case 'countersOnTriggerObject': {
      const facts = eventObjectFacts(ctx, scope);
      if (facts !== undefined) return counterCount(facts.counters, value.counter);
      // A deliberately card-tracking delayed scope may read remembered graveyard counters.
      if (scope.eventObjectId !== undefined || scope.triggerObjectId !== undefined) return 0;
      const card = ctx.state.players
        .flatMap((p) => p.graveyard)
        .find((card) => card.cardId === scope.triggerObjectCardId);
      return card?.rememberedCounters === undefined
        ? 0
        : counterCount(card.rememberedCounters, value.counter);
    }

    default:
      assertNever(value, 'resolution value');
  }
}
