/**
 * Effect resolution (brief §6.2): applying the mechanical outcome of `EffectSpec`s, plus
 * the shared damage/draw/life primitives used by combat and turn-based actions.
 */

import type { ObjectId, PlayerId } from '@mtg/shared';
import type { EffectSpec } from '../cards/definition';
import { effectTargetKind } from '../cards/definition';
import type { GameGen } from '../decisions';
import { debug, emit } from '../log/log';
import { moveObject, playerById } from '../state/objects';
import {
  effectivePT,
  findPermanent,
  getDefByOracleId,
  hasKeyword,
  isCreaturePermanent,
  opponentsOf,
} from '../state/queries';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../state/types';

/** Identity of whatever is dealing damage / causing an effect, for logging + rules. */
export interface EffectSource {
  cardId: string;
  name: string;
  oracleId: string;
  controllerId: PlayerId;
}

/** Deal non-combat or combat damage from `source` to a creature. */
export function dealDamageToCreature(
  ctx: GameContext,
  source: EffectSource,
  target: EnginePermanent,
  amount: number,
  opts: { combat: boolean; sourceHasDeathtouch: boolean; sourceHasLifelink: boolean },
): void {
  if (amount <= 0) return;
  target.damageMarked += amount;
  if (opts.sourceHasDeathtouch) target.damagedByDeathtouch = true;
  if (opts.sourceHasLifelink) gainLife(ctx, playerById(ctx, source.controllerId), amount);
  emit(ctx, 'damage', {
    source: source.name,
    sourceCardId: source.cardId,
    target: target.name,
    targetCardId: target.cardId,
    amount,
    combat: opts.combat,
  });
}

/** Deal damage from `source` to a player. Tracks commander combat damage (brief §5.7). */
export function dealDamageToPlayer(
  ctx: GameContext,
  source: EffectSource,
  target: EnginePlayerState,
  amount: number,
  opts: { combat: boolean; sourceIsCommander: boolean; sourceHasLifelink: boolean },
): void {
  if (amount <= 0) return;
  target.life -= amount;
  // 21+ combat damage from the same commander eliminates — COMBAT damage only (§5.7).
  if (opts.combat && opts.sourceIsCommander) {
    target.commanderDamageTaken[source.cardId] =
      (target.commanderDamageTaken[source.cardId] ?? 0) + amount;
  }
  if (opts.sourceHasLifelink) gainLife(ctx, playerById(ctx, source.controllerId), amount);
  emit(ctx, 'damage', {
    source: source.name,
    sourceCardId: source.cardId,
    target: target.id,
    amount,
    combat: opts.combat,
    commanderDamage: opts.combat && opts.sourceIsCommander,
  });
}

export function gainLife(ctx: GameContext, player: EnginePlayerState, amount: number): void {
  if (amount <= 0) return;
  player.life += amount;
  emit(ctx, 'lifeGain', { player: player.id, amount, life: player.life });
}

export function loseLife(ctx: GameContext, player: EnginePlayerState, amount: number): void {
  if (amount <= 0) return;
  player.life -= amount;
  emit(ctx, 'lifeLoss', { player: player.id, amount, life: player.life });
}

/**
 * Draw cards. Drawing from an empty library sets the loss flag checked at the next SBA
 * check, not an immediate loss (brief §5.6). A generator: a drawn commander (one shuffled
 * into the library) triggers the CR 903.9b hand-replacement choice inside `moveObject`.
 */
export function* drawCards(
  ctx: GameContext,
  player: EnginePlayerState,
  count: number,
): GameGen<void> {
  for (let i = 0; i < count; i++) {
    const top = player.library[0];
    if (top === undefined) {
      player.attemptedDrawFromEmptyLibrary = true;
      emit(ctx, 'drawFromEmptyLibrary', { player: player.id });
      debug(ctx, 'engine', `${player.id} attempted to draw from an empty library`);
      continue;
    }
    yield* moveObject(ctx, top, { zone: 'hand' });
    emit(ctx, 'draw', { player: player.id, cardId: top.cardId, name: top.name }, player.id);
  }
}

/** Is `target` (an object id or player id) still a legal target for `kind`? */
export function isTargetStillLegal(
  ctx: GameContext,
  targetId: ObjectId,
  kind: 'creature' | 'anyTarget' | 'spell',
  spellControllerId: PlayerId,
): boolean {
  if (kind === 'spell') {
    return ctx.state.stack.some((s) => s.id === targetId && s.kind === 'spell');
  }
  const player = ctx.state.players.find((p) => p.id === targetId);
  if (player !== undefined) {
    return kind === 'anyTarget' && !player.hasLost;
  }
  const perm = findPermanent(ctx, targetId);
  if (perm === undefined || !isCreaturePermanent(ctx, perm)) return false;
  if (perm.controllerId !== spellControllerId && hasKeyword(ctx, perm, 'hexproof')) return false;
  return true;
}

/**
 * Resolve a list of effects with pre-chosen targets (one entry per targeted effect, in
 * order). Individual targets that became illegal are skipped (CR 608.2b); the all-illegal
 * "fizzle" case is handled by the caller before invoking this.
 */
export function* resolveEffects(
  ctx: GameContext,
  source: EffectSource,
  effects: EffectSpec[],
  targets: ObjectId[],
): GameGen<void> {
  const controller = playerById(ctx, source.controllerId);
  let targetIdx = 0;

  for (const effect of effects) {
    const kind = effectTargetKind(effect);
    let targetId: ObjectId | null = null;
    if (kind !== null) {
      targetId = targets[targetIdx++] ?? null;
      if (targetId === null || !isTargetStillLegal(ctx, targetId, kind, source.controllerId)) {
        debug(ctx, 'effect', `${source.name}: target ${targetId ?? '(none)'} illegal — skipped`);
        continue;
      }
    }

    switch (effect.kind) {
      case 'pump': {
        const perm = findPermanent(ctx, targetId as ObjectId) as EnginePermanent;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} gets ${effect.power >= 0 ? '+' : ''}${effect.power}/${effect.toughness >= 0 ? '+' : ''}${effect.toughness} until end of turn`,
          targetCardId: perm.cardId,
          kind: 'ptDelta',
          power: effect.power,
          toughness: effect.toughness,
        });
        const pt = effectivePT(ctx, perm);
        emit(ctx, 'pump', {
          source: source.name,
          target: perm.name,
          power: effect.power,
          toughness: effect.toughness,
          nowPower: pt.power,
          nowToughness: pt.toughness,
        });
        break;
      }
      case 'grantKeyword': {
        const perm = findPermanent(ctx, targetId as ObjectId) as EnginePermanent;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} gains ${effect.keyword} until end of turn`,
          targetCardId: perm.cardId,
          kind: 'grantKeyword',
          keyword: effect.keyword,
        });
        emit(ctx, 'grantKeyword', {
          source: source.name,
          target: perm.name,
          keyword: effect.keyword,
        });
        break;
      }
      case 'damageTarget': {
        const targetPlayer = ctx.state.players.find((p) => p.id === targetId);
        if (targetPlayer !== undefined) {
          dealDamageToPlayer(ctx, source, targetPlayer, effect.amount, {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        } else {
          const perm = findPermanent(ctx, targetId as ObjectId) as EnginePermanent;
          dealDamageToCreature(ctx, source, perm, effect.amount, {
            combat: false,
            sourceHasDeathtouch: false,
            sourceHasLifelink: false,
          });
        }
        break;
      }
      case 'destroyTarget': {
        const perm = findPermanent(ctx, targetId as ObjectId) as EnginePermanent;
        if (hasKeyword(ctx, perm, 'indestructible')) {
          debug(ctx, 'effect', `${perm.name} is indestructible — destroy has no effect`);
          emit(ctx, 'destroyPrevented', { target: perm.name, source: source.name });
        } else {
          emit(ctx, 'destroy', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'graveyard' });
        }
        break;
      }
      case 'exileTarget': {
        const perm = findPermanent(ctx, targetId as ObjectId) as EnginePermanent;
        emit(ctx, 'exile', { target: perm.name, source: source.name });
        yield* moveObject(ctx, perm, { zone: 'exile' });
        break;
      }
      case 'counterTarget': {
        const idx = ctx.state.stack.findIndex((s) => s.id === targetId);
        const countered = ctx.state.stack[idx];
        if (countered !== undefined) {
          ctx.state.stack.splice(idx, 1);
          emit(ctx, 'counterSpell', { countered: countered.description, by: source.name });
          debug(ctx, 'stack', `${countered.description} countered by ${source.name}`);
          if (countered.card !== null) {
            yield* moveObject(ctx, countered.card, { zone: 'graveyard' });
          }
        }
        break;
      }
      case 'draw':
        yield* drawCards(ctx, controller, effect.count);
        break;
      case 'gainLife':
        gainLife(ctx, controller, effect.amount);
        break;
      case 'eachOpponentLosesLife':
        for (const opp of opponentsOf(ctx, controller.id)) {
          loseLife(ctx, opp, effect.amount);
        }
        break;
      case 'eachOpponentDamage':
        for (const opp of opponentsOf(ctx, controller.id)) {
          dealDamageToPlayer(ctx, source, opp, effect.amount, {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        }
        break;
    }
  }
}

/** End all until-end-of-turn effects (cleanup, CR 514.2). */
export function endUntilEotEffects(ctx: GameContext): void {
  if (ctx.state.effects.length > 0) {
    debug(ctx, 'effect', `ending ${ctx.state.effects.length} until-end-of-turn effect(s)`);
    ctx.state.effects = [];
  }
}

/** Source descriptor for a permanent (combat damage, triggers). */
export function permanentSource(perm: EnginePermanent): EffectSource {
  return {
    cardId: perm.cardId,
    name: perm.name,
    oracleId: perm.oracleId,
    controllerId: perm.controllerId,
  };
}

/** Does this permanent's damage carry deathtouch/lifelink (for combat)? */
export function combatDamageTraits(
  ctx: GameContext,
  perm: EnginePermanent,
): { deathtouch: boolean; lifelink: boolean } {
  return {
    deathtouch: hasKeyword(ctx, perm, 'deathtouch'),
    lifelink: hasKeyword(ctx, perm, 'lifelink'),
  };
}

/** Convenience: definition lookup for a permanent. */
export function defOf(
  ctx: GameContext,
  perm: EnginePermanent,
): ReturnType<typeof getDefByOracleId> {
  return getDefByOracleId(ctx, perm.oracleId, perm.name);
}
