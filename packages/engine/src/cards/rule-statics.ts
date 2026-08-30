/**
 * Rule-modifying statics (ADR 0010, Inc 13) — continuous effects that change the RULES of
 * casting or countering, rather than a permanent's characteristics.
 *
 * `StaticEffect`/`ContinuousOp` (`continuous-types.ts`) only express CR 613 layer operations
 * over PERMANENTS. "Your opponents can't cast spells" and "spells you cast cost {1} less" have
 * no permanent to apply an op to — the thing they modify is an action (casting) or an object
 * that is not yet on the battlefield (a spell on the stack) — so they get their own category
 * rather than being squeezed into the layer engine `gatherEffects` already assumes is
 * permanent-shaped.
 */

import type { ParsedManaCost } from '../mana/cost';
import type { Selector } from './selector';
import type { Value } from './value';

export type RuleStatic =
  /** "Spells you cast cost {1} less to cast" (Temur Battlecrier) / Eminence (The Ur-Dragon). */
  | {
      kind: 'costReduction';
      /** Generic-mana amount to reduce by. A `Value` so a dynamic count (Temur Battlecrier's
       * "for each creature you control with power 4 or greater") is expressed the same way a
       * fixed {1} (Eminence) is. */
      amount: Value;
      /** Colored-mana reduction (CR 601.2f — Morophon's {W}{U}{B}{R}{G} reduction). */
      coloredAmount?: ParsedManaCost;
      /** Restrict to spells matching this (printed) filter — "Dragon spells". Absent ⇒ any spell. */
      filter?: Selector;
      /** "OTHER Dragon spells" (Ur-Dragon) — excludes the source's own printed card. */
      excludesSelf?: boolean;
      /** "During your turn" (Temur Battlecrier) — inactive on any other player's turn. */
      yourTurnOnly?: boolean;
      /** Eminence (CR 702.114): active from the command zone too, not just the battlefield. */
      alsoFromCommandZone?: boolean;
      /** Affinity-style reduction printed on the spell itself, not granted from the battlefield. */
      selfOnly?: boolean;
      /**
       * "Boast abilities you activate cost {1} less to activate for each Dragon you control"
       * (Dragonkin Berserker) — this reduction applies to ACTIVATING an ability, not casting a
       * spell. Omitted defaults to `'cast'`, the overwhelmingly common case every other card
       * here uses.
       */
      appliesTo?: 'cast' | 'activate';
    }
  /**
   * "Creature spells you control can't be countered" (Rhythm of the Wild) — a STATE-DEPENDENT
   * rule, unlike `Ability.cantBeCountered`'s fixed-at-cast property (Last March of the Ents):
   * this one exists only while the source is on the battlefield and can stop applying if it
   * leaves before the spell resolves.
   */
  | { kind: 'cantBeCountered'; filter?: Selector }
  /** "Your opponents can't cast spells during your turn" (Dragonlord Dromoka). */
  | { kind: 'cantCastSpells'; who: 'opponents'; yourTurnOnly: boolean }
  /** "You may cast Dragon spells from the top of your library" (Korlessa, Scale Singer). */
  | { kind: 'castFromZone'; zone: 'libraryTop'; filter?: Selector }
  /** "If a creature you control that entered this turn would deal damage, it deals twice that
   * much damage instead" (Neriv, Heart of the Storm) — a damage REPLACEMENT effect (CR 616). */
  | { kind: 'damageDoubled'; sourceFilter: Selector }
  /** "Sources would deal damage to an opponent or their permanents" (Gisela). */
  | { kind: 'damageDoubledToOpponents' }
  /** "Sources would deal damage to you or your permanents" (Gisela). */
  | { kind: 'damageHalvedToYou' }
  /** "If an effect would create one or more tokens under your control, it creates twice that many instead." */
  | { kind: 'tokenCountMultiplier'; multiplier: number }
  /** A CR 616 replacement for counters placed on a matching permanent. */
  | {
      kind: 'counterPlacementReplacement';
      filter: Selector;
      counter?: string;
      multiplier: number;
      addition: number;
    }
  /** "Creatures can't attack you unless their controller pays {N} per creature" (Ghostly Prison). */
  | { kind: 'attackTax'; amount: number }
  | { kind: 'convoke' }
  | { kind: 'improvise' }
  | { kind: 'kicker'; cost?: ParsedManaCost }
  | { kind: 'noMaximumHandSize' }
  | { kind: 'triggerAdditionalOnArtifactOrCreatureEntry' }
  | { kind: 'artifactTokenCreatesThopter' };
