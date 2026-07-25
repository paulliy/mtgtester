/**
 * Read-only state queries: definitions, effective characteristics (computed through the CR
 * 613 layer engine — see `effects/continuous.ts`), players in the game, and mana sources.
 */

import type { Color, ObjectId, OracleId, PlayerId } from '@mtg/shared';
import type {
  Ability,
  AbilityCost,
  CardDefinition,
  KeywordAbility,
  ManaAbilitySpec,
} from '../cards/definition';
import { TAP_COST } from '../cards/definition';
import { evaluateCondition } from '../cards/condition';
import { computeCharacteristics } from '../effects/continuous';
import { UnmodeledCardError } from '../errors';
import type { ManaSource, ManaUnit } from '../mana/cost';
import type { EngineObject, EnginePermanent, EnginePlayerState, GameContext } from './types';

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

/**
 * Triggered abilities the permanent currently has, through the layer system. Reading these
 * from the `CardDefinition` instead would mean a permanent that lost its abilities still
 * triggered, and a granted trigger could never fire (ADR 0007).
 */
export function triggersOf(ctx: GameContext, perm: EnginePermanent): Ability[] {
  return computeCharacteristics(ctx, perm).triggers;
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

/** Any object with this stable `cardId`, in whatever zone it currently occupies. */
function findObjectByCardId(ctx: GameContext, cardId: string): EngineObject | undefined {
  const s = ctx.state;
  const zones: EngineObject[][] = [s.battlefield, s.exile];
  for (const player of s.players) {
    zones.push(player.hand, player.library, player.graveyard, player.commandZone);
  }
  for (const zone of zones) {
    const found = zone.find((o) => o.cardId === cardId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Derive the symbols of a state-dependent mana ability (`ManaAbilitySpec.dynamic`).
 *
 * Returned as a spec with concrete `units` so everything downstream — the payment solver's
 * per-unit backtracking most of all — sees an ordinary multi-choice source and needs no
 * knowledge that the symbols were computed.
 */
function resolveDynamicUnits(
  ctx: GameContext,
  spec: ManaAbilitySpec,
  perm: EnginePermanent,
): ManaAbilitySpec {
  if (spec.dynamic === undefined) return spec;

  const symbols: (Color | 'C')[] = [];
  const add = (sym: Color | 'C'): void => {
    if (!symbols.includes(sym)) symbols.push(sym);
  };

  if (spec.dynamic === 'commanderIdentity') {
    // CR 903.4 identity of the controller's commander(s), wherever they currently are — the
    // ability reads the commander's identity, not its presence. A colorless identity yields
    // no symbols, which correctly makes the source produce nothing.
    const owner = ctx.state.players.find((p) => p.id === perm.controllerId);
    for (const cardId of owner?.commanderCardIds ?? []) {
      const commander = findObjectByCardId(ctx, cardId);
      if (commander === undefined) continue;
      const def = ctx.defs.get(commander.oracleId);
      for (const color of def?.colorIdentity ?? []) add(color);
    }
  } else {
    // "any color that a land an opponent controls could produce" — union over opponents'
    // lands, read through the layer engine so a Blood Moon'd land contributes {R}.
    for (const opponent of opponentsOf(ctx, perm.controllerId)) {
      for (const land of controlledPermanents(ctx, opponent.id)) {
        const chars = computeCharacteristics(ctx, land);
        if (!chars.types.includes('Land')) continue;
        for (const ability of chars.manaAbilities) {
          for (const unit of resolveDynamicUnits(ctx, ability, land).units) {
            for (const sym of unit) if (sym !== 'C') add(sym);
          }
        }
      }
    }
  }

  return { ...spec, units: symbols.length > 0 ? [symbols] : [] };
}

/**
 * Can this permanent pay the NON-mana components of an activation cost right now?
 *
 * The `mana` component is deliberately excluded and always answers true: deciding it needs the
 * pool and the full source list, which is the caller's job (`canPay`). Folding it in here would
 * make mana-source enumeration recursive.
 */
export function canPayNonManaCosts(
  ctx: GameContext,
  perm: EnginePermanent,
  costs: readonly AbilityCost[],
): boolean {
  for (const cost of costs) {
    switch (cost.kind) {
      case 'tap':
        if (perm.tapped) return false;
        // CR 302.6 — summoning sickness blocks {T} costs on creatures, nothing else.
        if (
          computeCharacteristics(ctx, perm).types.includes('Creature') &&
          perm.summoningSick &&
          !hasKeyword(ctx, perm, 'haste')
        ) {
          return false;
        }
        break;
      case 'sacrificeSelf':
        break;
      case 'removeCounters':
        if ((perm.counters[cost.counter] ?? 0) < cost.count) return false;
        break;
      case 'mana':
        break;
    }
  }
  return true;
}

/** A stable key for a cost list, so abilities with identical costs can be grouped. */
function costSignature(costs: readonly AbilityCost[]): string {
  return JSON.stringify(costs);
}

/**
 * Untapped mana sources `playerId` could activate right now. A creature's {T} mana
 * ability is unavailable while summoning-sick without haste (CR 302.6).
 *
 * A permanent with several mana abilities — a dual-typed land, or a basic given a second type
 * by Urborg — is collapsed into ONE source whose single unit offers every symbol as a choice.
 * That is exact rather than an approximation: a permanent can only be tapped once, so N
 * abilities each producing one mana are indistinguishable from one mana chosen among their
 * symbols. `planPayment`'s per-unit backtracking already solves multi-choice units.
 *
 * Two cases break that equivalence and halt loudly instead (brief §6.3):
 *   - abilities producing *different amounts*, where the choice is strategic, not cosmetic;
 *   - abilities with *different costs*, where "it can only be tapped once" no longer holds —
 *     a sacrifice ability and a tap ability are not interchangeable at all.
 */
export function manaSourcesFor(ctx: GameContext, playerId: PlayerId): ManaSource[] {
  const sources: ManaSource[] = [];
  for (const perm of controlledPermanents(ctx, playerId)) {
    const chars = computeCharacteristics(ctx, perm);
    // Mana abilities are computed, not printed: a layer-4 subtype change replaces them
    // (Blood Moon → a Mountain that taps for R), layer 6 can remove them outright, and layer 6
    // can also GRANT them (Chromatic Lantern).
    const abilities = chars.manaAbilities
      // "Activate only if you control a Dragon" — an unavailable source is not a source.
      .filter(
        (a) =>
          a.condition === undefined ||
          evaluateCondition(ctx, a.condition, {
            cardId: perm.cardId,
            controllerId: perm.controllerId,
          }),
      )
      .map((a) => resolveDynamicUnits(ctx, a, perm))
      // A dynamic source can resolve to nothing at all — Fellwar Stone with no opposing
      // lands taps for no mana, so it must not be offered as a payment source.
      .filter((a) => a.units.length > 0)
      // Not every mana ability costs {T}: "Sacrifice this creature: Add {R}{R}" is available
      // from a tapped, summoning-sick creature. Availability is per ability, not per permanent.
      .filter((a) => canPayNonManaCosts(ctx, perm, a.costs ?? TAP_COST));
    if (abilities.length === 0) continue;
    const costs = (abilities[0] as ManaAbilitySpec).costs ?? TAP_COST;
    if (abilities.length === 1) {
      sources.push({ cardId: perm.cardId, units: (abilities[0] as ManaAbilitySpec).units, costs });
      continue;
    }
    const signatures = new Set(abilities.map((a) => costSignature(a.costs ?? TAP_COST)));
    if (signatures.size > 1) {
      throw new UnmodeledCardError(
        perm.name,
        [`choice among mana abilities with different costs: ${[...signatures].join(' | ')}`],
        'choosing among mana abilities',
      );
    }
    if (abilities.some((a) => a.units.length !== 1)) {
      throw new UnmodeledCardError(
        perm.name,
        [
          `choice among mana abilities producing different amounts: ${abilities
            .map((a) => a.units.map((u) => u.join('/')).join('+') || '<nothing>')
            .join(' | ')}`,
        ],
        'choosing among mana abilities',
      );
    }
    const symbols: (Color | 'C')[] = [];
    for (const ability of abilities) {
      for (const symbol of ability.units[0] as ManaUnit) {
        if (!symbols.includes(symbol)) symbols.push(symbol);
      }
    }
    sources.push({ cardId: perm.cardId, units: [symbols], costs });
  }
  return sources;
}
