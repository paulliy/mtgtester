/**
 * Read-only state queries: definitions, effective characteristics (computed through the CR
 * 613 layer engine — see `effects/continuous.ts`), players in the game, and mana sources.
 */

import type { ObjectId, OracleId, PlayerId } from '@mtg/shared';
import type { CardDefinition, KeywordAbility } from '../cards/definition';
import { computeCharacteristics } from '../effects/continuous';
import { UnmodeledCardError } from '../errors';
import type { ManaSource } from '../mana/cost';
import type { EnginePermanent, EnginePlayerState, GameContext } from './types';

export function getDefByOracleId(
  ctx: GameContext,
  oracleId: OracleId,
  nameForError: string,
): CardDefinition {
  const def = ctx.defs.get(oracleId);
  if (def === undefined) {
    throw new Error(`engine bug: no CardDefinition for ${nameForError} (${oracleId})`);
  }
  return def;
}

/** Halt loudly when a card whose behavior is needed is not modeled (brief §6.3). */
export function requireModeled(def: CardDefinition, situation: string): void {
  if (!def.modeled) {
    throw new UnmodeledCardError(def.name, def.unmodeledReasons, situation);
  }
}

export function findPermanent(ctx: GameContext, id: ObjectId): EnginePermanent | undefined {
  return ctx.state.battlefield.find((p) => p.id === id);
}

/** Current card types include Creature after the layer system (Mutavault, etc.). */
export function isCreaturePermanent(ctx: GameContext, perm: EnginePermanent): boolean {
  return computeCharacteristics(ctx, perm).types.includes('Creature');
}

/** Effective power/toughness through the CR 613 layer engine. */
export function effectivePT(
  ctx: GameContext,
  perm: EnginePermanent,
): { power: number; toughness: number } {
  const c = computeCharacteristics(ctx, perm);
  return { power: c.power, toughness: c.toughness };
}

/** Effective keywords through the CR 613 layer engine (grants in layer 6). */
export function hasKeyword(ctx: GameContext, perm: EnginePermanent, kw: KeywordAbility): boolean {
  return computeCharacteristics(ctx, perm).keywords.includes(kw);
}

/** Players still in the game, in turn order starting from the active player (APNAP). */
export function playersInApnapOrder(ctx: GameContext): EnginePlayerState[] {
  const s = ctx.state;
  const order: EnginePlayerState[] = [];
  for (let i = 0; i < s.turnOrder.length; i++) {
    const id = s.turnOrder[(s.activePlayerIndex + i) % s.turnOrder.length] as PlayerId;
    const p = s.players.find((pl) => pl.id === id);
    if (p !== undefined && !p.hasLost) order.push(p);
  }
  return order;
}

export function activePlayer(ctx: GameContext): EnginePlayerState {
  const id = ctx.state.turnOrder[ctx.state.activePlayerIndex] as PlayerId;
  const p = ctx.state.players.find((pl) => pl.id === id);
  if (p === undefined) throw new Error('engine bug: active player not found');
  return p;
}

export function opponentsOf(ctx: GameContext, playerId: PlayerId): EnginePlayerState[] {
  return playersInApnapOrder(ctx).filter((p) => p.id !== playerId);
}

export function controlledPermanents(ctx: GameContext, playerId: PlayerId): EnginePermanent[] {
  return ctx.state.battlefield.filter((p) => p.controllerId === playerId);
}

/**
 * Untapped mana sources `playerId` could activate right now. A creature's {T} mana
 * ability is unavailable while summoning-sick without haste (CR 302.6).
 * Multi-ability mana producers (choice of ability) are not modeled in Phase 2 — the
 * interpreter yields at most one ability per Phase 2 card; halt if one slips through.
 */
export function manaSourcesFor(ctx: GameContext, playerId: PlayerId): ManaSource[] {
  const sources: ManaSource[] = [];
  for (const perm of controlledPermanents(ctx, playerId)) {
    if (perm.tapped) continue;
    const def = getDefByOracleId(ctx, perm.oracleId, perm.name);
    const chars = computeCharacteristics(ctx, perm);
    // A layer-4 effect can override mana production (Blood Moon → a Mountain that taps for R).
    const abilities =
      chars.manaOverride !== null
        ? chars.manaOverride.map((units) => ({ units }))
        : def.manaAbilities;
    if (abilities.length === 0) continue;
    if (chars.types.includes('Creature') && perm.summoningSick && !hasKeyword(ctx, perm, 'haste')) {
      continue;
    }
    if (abilities.length > 1) {
      throw new UnmodeledCardError(
        def.name,
        ['multiple mana abilities on one permanent'],
        'choosing among mana abilities',
      );
    }
    const ability = abilities[0];
    if (ability !== undefined) {
      sources.push({ cardId: perm.cardId, units: ability.units });
    }
  }
  return sources;
}
