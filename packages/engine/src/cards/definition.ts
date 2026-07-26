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
import type { RuleStatic } from './rule-statics';

export type { Condition } from './condition';
export type { StaticEffect, ContinuousOp, Characteristics } from './continuous-types';
export type { Value } from './value';
export type { Selector } from './selector';
export type { RuleStatic } from './rule-statics';

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
  /**
   * A representative Scryfall printing id, for image lookup in the UI (Phase 4). Absent for
   * synthetic token definitions (`registerTokenDef`), which have no real printing.
   */
  scryfallId?: string;
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
  /** Printed ward cost (CR 702.21), or absent. Parameterized, so not in `keywords`. */
  ward?: ParsedManaCost;
  /** Printed "protection from `<colors>`" (CR 702.16). */
  protectionFrom?: Color[];
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
  /**
   * "This spell can't be countered" (CR 601), surfaced independent of `spellAbility` because a
   * PERMANENT card can print it too (Dragonlord Dromoka) — meaning the spell that becomes that
   * permanent, which has no `spellAbility` to carry the flag on. `apply.ts` reads this to give
   * such a cast a minimal (zero-effect) stack `Ability` so `protectedFromCounter` can see it.
   */
  spellCantBeCountered?: boolean;
  /** Triggered abilities (kind 'triggered'). */
  triggers: Ability[];
  /** Continuous effects this card contributes while a permanent (static abilities / CDAs). */
  staticEffects: StaticEffect[];
  /**
   * Rule-modifying statics — cost reduction, "can't be countered", "can't cast spells", casting
   * from a non-hand zone. Distinct from `staticEffects`: those are CR 613 layer ops over
   * permanents, these modify the rules of casting/countering itself (see `rule-statics.ts`).
   */
  ruleStatics: RuleStatic[];
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
