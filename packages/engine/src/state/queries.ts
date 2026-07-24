/**
 * Read-only state queries: definitions, effective characteristics (printed values +
 * counters + until-end-of-turn effects — the Phase 2 subset of the CR 613 layer system),
 * players in the game, and mana sources.
 */

import type { ObjectId, OracleId, PlayerId } from '@mtg/shared';
import type { CardDefinition, KeywordAbility } from '../cards/definition';
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

export function isCreaturePermanent(ctx: GameContext, perm: EnginePermanent): boolean {
  return getDefByOracleId(ctx, perm.oracleId, perm.name).types.includes('Creature');
}

/** Effective power/toughness: printed + counters + until-EOT deltas (Phase 2 layers). */
export function effectivePT(
  ctx: GameContext,
  perm: EnginePermanent,
): { power: number; toughness: number } {
  let power = perm.power ?? 0;
  let toughness = perm.toughness ?? 0;
  const plus = perm.counters['+1/+1'] ?? 0;
  const minus = perm.counters['-1/-1'] ?? 0;
  power += plus - minus;
  toughness += plus - minus;
  for (const eff of ctx.state.effects) {
    if (eff.kind === 'ptDelta' && eff.targetCardId === perm.cardId) {
      power += eff.power ?? 0;
      toughness += eff.toughness ?? 0;
    }
  }
  return { power, toughness };
}

/** Effective keywords: definition keywords + until-EOT grants. */
export function hasKeyword(ctx: GameContext, perm: EnginePermanent, kw: KeywordAbility): boolean {
  const def = getDefByOracleId(ctx, perm.oracleId, perm.name);
  if (def.keywords.includes(kw)) return true;
  return ctx.state.effects.some(
    (eff) => eff.kind === 'grantKeyword' && eff.targetCardId === perm.cardId && eff.keyword === kw,
  );
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
    const def = getDefByOracleId(ctx, perm.oracleId, perm.name);
    if (def.manaAbilities.length === 0 || perm.tapped) continue;
    if (def.types.includes('Creature') && perm.summoningSick && !hasKeyword(ctx, perm, 'haste')) {
      continue;
    }
    if (def.manaAbilities.length > 1) {
      throw new UnmodeledCardError(
        def.name,
        ['multiple mana abilities on one permanent'],
        'choosing among mana abilities',
      );
    }
    const ability = def.manaAbilities[0];
    if (ability !== undefined) {
      sources.push({ cardId: perm.cardId, units: ability.units });
    }
  }
  return sources;
}
