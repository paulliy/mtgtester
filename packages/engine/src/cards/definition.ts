/**
 * The engine's internal card model (brief §6). An `OracleCard` (raw Scryfall projection)
 * is interpreted once into a `CardDefinition`: parsed cost, implemented keywords, mana
 * abilities, spell effects, and triggered abilities. Anything the interpreter cannot fully
 * account for marks the definition `modeled: false` with a reason — the engine halts
 * loudly when such a card's behavior is actually needed, never guesses (brief §6.3).
 */

import type { Color, OracleId } from '@mtg/shared';
import type { ParsedManaCost } from '../mana/cost';
import type { Ability, KeywordAbility, ManaAbilitySpec } from './ability';
import type { StaticEffect } from './continuous-types';

export type { StaticEffect, ContinuousOp, Characteristics } from './continuous-types';
export type { Value } from './value';
export type { Selector } from './selector';

// The card model's behavior lives in the ability IR (ADR 0004); re-export the pieces
// consumers reference so existing imports from `definition` keep working.
export { IMPLEMENTED_KEYWORDS } from './ability';
export type {
  Ability,
  Effect,
  KeywordAbility,
  ManaAbilitySpec,
  TargetKind,
  TargetSpec,
  TriggerEvent,
} from './ability';

/** Interpreted card. Immutable; one per oracle id per game. */
export interface CardDefinition {
  oracleId: OracleId;
  name: string;
  typeLine: string;
  supertypes: string[];
  types: string[];
  subtypes: string[];
  colors: Color[];
  /** Parsed cost; null for lands / cost-less cards (and for unmodeled costs). */
  manaCost: ParsedManaCost | null;
  /** True if the printed cost contains symbols we cannot pay yet ({X}, hybrid, …). */
  hasUnsupportedCost: boolean;
  /** Parsed printed P/T; null for non-creatures. `*` values are unmodeled. */
  power: number | null;
  toughness: number | null;
  /** Parsed starting loyalty (planeswalkers, CR 306.5b); null otherwise. `*` is unmodeled. */
  loyalty: number | null;
  /** Parsed starting defense (battles, CR 310.6); null otherwise. `*` is unmodeled. */
  defense: number | null;
  keywords: KeywordAbility[];
  manaAbilities: ManaAbilitySpec[];
  entersTapped: boolean;
  /** For instants/sorceries: the spell's ability (kind 'spell'), or null. */
  spellAbility: Ability | null;
  /** Triggered abilities (kind 'triggered'). */
  triggers: Ability[];
  /** Continuous effects this card contributes while a permanent (static abilities / CDAs). */
  staticEffects: StaticEffect[];
  /**
   * False when any behavior of this card is beyond the Phase 2 engine. The engine halts
   * with `UnmodeledCardError` the moment such a card's behavior is needed (brief §6.3).
   */
  modeled: boolean;
  unmodeledReasons: string[];
}

export function isCreature(def: CardDefinition): boolean {
  return def.types.includes('Creature');
}

export function isLand(def: CardDefinition): boolean {
  return def.types.includes('Land');
}

export function isInstantOrSorcery(def: CardDefinition): boolean {
  return def.types.includes('Instant') || def.types.includes('Sorcery');
}

export function isLegendary(def: CardDefinition): boolean {
  return def.supertypes.includes('Legendary');
}

/** Card types that resolve/play onto the battlefield as permanents (CR 110.4a). */
export const PERMANENT_CARD_TYPES = [
  'Creature',
  'Artifact',
  'Enchantment',
  'Land',
  'Planeswalker',
  'Battle',
] as const;

/** Permanent card types castable/playable onto the battlefield. */
export function isPermanentCard(def: CardDefinition): boolean {
  return def.types.some((t) => (PERMANENT_CARD_TYPES as readonly string[]).includes(t));
}
