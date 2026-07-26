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
      /** Restrict to spells matching this (printed) filter — "Dragon spells". Absent ⇒ any spell. */
      filter?: Selector;
      /** "OTHER Dragon spells" (Ur-Dragon) — excludes the source's own printed card. */
      excludesSelf?: boolean;
      /** "During your turn" (Temur Battlecrier) — inactive on any other player's turn. */
      yourTurnOnly?: boolean;
      /** Eminence (CR 702.114): active from the command zone too, not just the battlefield. */
      alsoFromCommandZone?: boolean;
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
  | { kind: 'castFromZone'; zone: 'libraryTop'; filter?: Selector };
