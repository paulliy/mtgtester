/**
 * Continuous-effect data types (ADR 0005) — the CR 613 layer operations a card contributes.
 * Pure types (no engine imports) so `CardDefinition` can hold them without a cycle. The
 * engine that applies them lives in `effects/continuous.ts`.
 */

import type { Color } from '@mtg/shared';
import type {
  Ability,
  ActivatedAbility,
  KeywordAbility,
  ManaAbilitySpec,
  WardCost,
} from './ability';
import type { Condition } from './condition';
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
      /** "Is the chosen type in addition to its other types" (Roaming Throne). */
      addChosenSubtype?: true;
      /** Changeling (CR 702.73): every creature type in CR 205.3m. */
      addAllCreatureTypes?: boolean;
      /** Set the land subtype and drop other land subtypes (Blood Moon → Mountain). */
      setLandSubtype?: string;
      /**
       * Replace the ENTIRE type line, dropping every existing type (Sarkhan, the Dragonspeaker's
       * "becomes a … creature" — no "in addition to its other types", unlike Atarka Monument's
       * plain `addTypes`, so he genuinely stops being a planeswalker while this applies).
       */
      setTypes?: string[];
      setSubtypes?: string[];
      /**
       * Remove the abilities the affected permanent generates from its rules text (CR 305.7,
       * the consequence of Blood Moon *setting* a land's subtype). This is what lets one
       * continuous effect extinguish another's — the core CR 613.8 dependency.
       */
      loseAbilities?: boolean;
    }
  // Layer 6 — ability adding and removing.
  // Layer 5 — color-changing.
  | { layer: 5; setColors: Color[] }
  | { layer: 6; addKeyword: KeywordAbility }
  /** "Creatures with counters on them can't be blocked" (Herald of Secret Streams). */
  | { layer: 6; setCantBeBlocked: true }
  /** "Creatures your opponents control attack each combat if able." */
  | { layer: 6; setMustAttackEachCombat: true }
  /** A static effect that goads each affected creature. */
  | { layer: 6; addGoad: true }
  /** "Other Dragons you control have ward {2}" — parameterized, so not an `addKeyword`. */
  | { layer: 6; addWard: WardCost }
  /** "Protection from white and from black" (CR 702.16). */
  | { layer: 6; addProtection: Color[] }
  /**
   * "Protection from the chosen color" (Flickering Ward) — the color is per-permanent state
   * (`EnginePermanent.chosenOption`), not fixed, so `gatherEffects` resolves this into a
   * concrete `addProtection` per application rather than `applyOpTo` reading it directly.
   */
  | { layer: 6; addProtectionFromChosenColor: true }
  /** Grant a triggered ability — "Equipped creature has 'Whenever …'". */
  | { layer: 6; addTrigger: Ability }
  /** Grant an activated ability — "Equipped creature has '{T}: Deal 1 damage...'". */
  | { layer: 6; addActivatedAbility: ActivatedAbility }
  /** Grant a mana ability — Chromatic Lantern's "Lands you control have '{T}: Add …'". */
  | { layer: 6; addManaAbility: ManaAbilitySpec }
  /** "Loses all abilities" as an effect in its own right (Humility), distinct from the
   *  CR 305.7 consequence of a layer-4 subtype change. */
  | { layer: 6; loseAllAbilities: true }
  // Layer 7a — characteristic-defining P/T (Tarmogoyf).
  | { layer: 7; sublayer: 'a'; power: Value; toughness: Value }
  // Layer 7b — set P/T to a specific value (Mutavault becomes 2/2).
  | { layer: 7; sublayer: 'b'; power: Value; toughness: Value }
  // Layer 7d — modify (but not set) P/T (Giant Growth pump). 7c is counters, applied inline.
  | { layer: 7; sublayer: 'd'; power: number | Value; toughness: number | Value };

/** A continuous effect a card contributes while it is a permanent (static ability or CDA). */
export interface StaticEffect {
  /** Which permanents it affects (its own permanent for a CDA / self-buff). */
  affects: Selector;
  op: ContinuousOp;
  /** Optional condition evaluated when gathering static effects (e.g. ward while untapped). */
  condition?: Condition;
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
  /**
   * Colors (CR 105). Layer 5 (color-changing) is NOT implemented, so this is always the
   * printed color — but selectors read it from here, so layer 5 lands in exactly one place
   * when it arrives instead of chasing down printed-color reads (the ADR 0007 problem).
   */
  colors: Color[];
  keywords: KeywordAbility[];
  /**
   * Ward cost (CR 702.21), or null. Parameterized, so it is a field rather than a keyword: a
   * permanent has at most one ward here — the cheapest is not merged, because no card in the
   * pool grants a second one, and silently combining them would be a guess.
   */
  ward: WardCost | null;
  /** Colors this permanent has protection from (CR 702.16). */
  protectionFrom: Color[];
  /** Computed evasion from a layer-6 effect, separate from printed characteristics. */
  cantBeBlocked: boolean;
  /** Static goad requirements, stored as the controlling player id. */
  staticGoadedBy?: string[];
  /** Static attack requirement checked by combat. */
  mustAttackEachCombat?: boolean;
  /** Triggered abilities the permanent currently has (CR 603). */
  triggers: Ability[];
  /** Mana abilities the permanent currently has — printed, or replaced by a subtype change. */
  manaAbilities: ManaAbilitySpec[];
  /** Activated abilities granted to the permanent. */
  activatedAbilities?: ActivatedAbility[];
  power: number;
  toughness: number;
  /** Power and toughness after layer 7b, before counters and 7d modifications (CR 613.4). */
  basePower?: number;
  baseToughness?: number;
  /**
   * True once this permanent's rules-text abilities have been stripped — by a layer-4 subtype
   * change (CR 305.7) or by a layer-6 "loses all abilities". Continuous effects sourced from
   * it stop existing from that layer onward.
   */
  loseAbilities: boolean;
}
