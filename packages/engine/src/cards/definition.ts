/**
 * The engine's internal card model (brief §6). An `OracleCard` (raw Scryfall projection)
 * is interpreted once into a `CardDefinition`: parsed cost, implemented keywords, mana
 * abilities, spell effects, and triggered abilities. Anything the interpreter cannot fully
 * account for marks the definition `modeled: false` with a reason — the engine halts
 * loudly when such a card's behavior is actually needed, never guesses (brief §6.3).
 */

import type { Color, OracleId } from '@mtg/shared';
import type { ParsedManaCost } from '../mana/cost';
import type { Ability, ActivatedAbility, KeywordAbility, ManaAbilitySpec } from './ability';
import type { Condition } from './condition';
import type { StaticEffect } from './continuous-types';

export type { Condition } from './condition';
export type { StaticEffect, ContinuousOp, Characteristics } from './continuous-types';
export type { Value } from './value';
export type { Selector } from './selector';

// The card model's behavior lives in the ability IR (ADR 0004); re-export the pieces
// consumers reference so existing imports from `definition` keep working.
export { IMPLEMENTED_KEYWORDS, TAP_COST } from './ability';
export type {
  Ability,
  AbilityCost,
  ActivatedAbility,
  Effect,
  EffectRef,
  KeywordAbility,
  ManaAbilitySpec,
  SearchDestination,
  TargetKind,
  TargetSpec,
  TriggerHead,
  TriggerSpec,
  TriggerSubject,
  TriggerWhen,
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
  /**
   * Color identity (CR 903.4), verbatim from Scryfall. Distinct from `colors`: it includes mana
   * symbols in rules text, which is why a commander's identity — what "your commander's color
   * identity" mana abilities read — cannot be derived from `colors`.
   */
  colorIdentity: Color[];
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
  /** "`<costs>`: `<effect>`" abilities that use the stack (CR 602). */
  activatedAbilities: ActivatedAbility[];
  entersTapped: boolean;
  /**
   * "enters tapped unless <condition>" / "as this enters, you may pay 2 life; if you don't, it
   * enters tapped" — a replacement effect applied as the permanent enters (CR 614.1c), NOT a
   * trigger. When present it decides tapped-ness and `entersTapped` is ignored: the permanent
   * enters tapped exactly when the condition is FALSE.
   */
  entersTappedUnless?: Condition;
  /**
   * Counters the permanent enters the battlefield with (CR 614.1c) — a replacement effect,
   * NOT a triggered ability. The distinction is load-bearing: as a trigger, a 0/0 that
   * "enters with three +1/+1 counters" would briefly exist at 0 toughness and die to a
   * state-based action before its own trigger could resolve.
   */
  entersWithCounters?: Record<string, number>;
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
