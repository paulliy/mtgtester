/**
 * Continuous-effect data types (ADR 0005) — the CR 613 layer operations a card contributes.
 * Pure types (no engine imports) so `CardDefinition` can hold them without a cycle. The
 * engine that applies them lives in `effects/continuous.ts`.
 */

import type { Ability, KeywordAbility, ManaAbilitySpec } from './ability';
import type { Selector } from './selector';
import type { Value } from './value';

/** One layer operation. The `layer`/`sublayer` fix its place in the CR 613 order. */
export type ContinuousOp =
  // Layer 4 — type-changing.
  | {
      layer: 4;
      /** Card types to add (Mutavault → Creature; kept alongside existing types). */
      addTypes?: string[];
      /** Subtypes to add, keeping the existing ones (Urborg → "a Swamp in addition"). */
      addSubtypes?: string[];
      /** Set the land subtype and drop other land subtypes (Blood Moon → Mountain). */
      setLandSubtype?: string;
      /**
       * Remove the abilities the affected permanent generates from its rules text (CR 305.7,
       * the consequence of Blood Moon *setting* a land's subtype). This is what lets one
       * continuous effect extinguish another's — the core CR 613.8 dependency.
       */
      loseAbilities?: boolean;
    }
  // Layer 6 — ability adding and removing.
  | { layer: 6; addKeyword: KeywordAbility }
  /** "Loses all abilities" as an effect in its own right (Humility), distinct from the
   *  CR 305.7 consequence of a layer-4 subtype change. */
  | { layer: 6; loseAllAbilities: true }
  // Layer 7a — characteristic-defining P/T (Tarmogoyf).
  | { layer: 7; sublayer: 'a'; power: Value; toughness: Value }
  // Layer 7b — set P/T to a specific value (Mutavault becomes 2/2).
  | { layer: 7; sublayer: 'b'; power: Value; toughness: Value }
  // Layer 7d — modify (but not set) P/T (Giant Growth pump). 7c is counters, applied inline.
  | { layer: 7; sublayer: 'd'; power: number; toughness: number };

/** A continuous effect a card contributes while it is a permanent (static ability or CDA). */
export interface StaticEffect {
  /** Which permanents it affects (its own permanent for a CDA / self-buff). */
  affects: Selector;
  op: ContinuousOp;
}

/**
 * A permanent's characteristics after the layer system has been applied. This is the single
 * source of truth: nothing outside the interpreter should read a permanent's types, keywords,
 * abilities or mana production off its `CardDefinition` (ADR 0007).
 *
 * `triggers` and `manaAbilities` live here, not just `keywords`, because layer 6 adds and
 * removes *abilities* — Forge's equivalent layer covers "keywords, spellabilities, triggers,
 * replacements". Keeping them printed-only made "loses all abilities" unrepresentable and
 * forced mana production to be special-cased.
 */
export interface Characteristics {
  supertypes: string[];
  types: string[];
  subtypes: string[];
  keywords: KeywordAbility[];
  /** Triggered abilities the permanent currently has (CR 603). */
  triggers: Ability[];
  /** Mana abilities the permanent currently has — printed, or replaced by a subtype change. */
  manaAbilities: ManaAbilitySpec[];
  power: number;
  toughness: number;
  /**
   * True once this permanent's rules-text abilities have been stripped — by a layer-4 subtype
   * change (CR 305.7) or by a layer-6 "loses all abilities". Continuous effects sourced from
   * it stop existing from that layer onward.
   */
  loseAbilities: boolean;
}
