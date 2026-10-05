/**
 * Modal triggered and activated abilities (CR 700.2a-b). The mode is chosen as part of
 * activating the ability, or as part of putting the triggered ability on the stack — BEFORE its
 * targets (CR 601.2b-c, 602.2b, 603.3c), and never at resolution. A mode whose targets cannot be
 * chosen cannot be chosen at all; a triggered ability with no choosable mode is removed from the
 * stack. Spells have their own announcement path (`modalSelections` in `legal.ts`).
 *
 * Once the mode is chosen, `abilityForModes` folds the chosen effects into a mode-free `Ability`,
 * so the stack entry, fizzle check and executor only ever see what was announced.
 */

import type { TargetSpec } from '../cards/definition';
import type { Ability } from '../cards/ability';

export type AbilityModes = NonNullable<Ability['modes']>;

/** Every legal mode subset by count alone (CR 700.2d), before target availability. */
export function abilityModeSelections(modes: AbilityModes): number[][] {
  const out: number[][] = [];
  const visit = (next: number, chosen: number[]): void => {
    if (chosen.length >= modes.minChoices && chosen.length <= modes.maxChoices)
      out.push([...chosen]);
    if (chosen.length === modes.maxChoices) return;
    for (let i = next; i < modes.options.length; i++) {
      chosen.push(i);
      visit(modes.repeatable === true ? i : i + 1, chosen);
      chosen.pop();
    }
  };
  visit(0, []);
  return out;
}

/**
 * The target slots the chosen modes announce, or `undefined` when a chosen mode carries no
 * ownership metadata (a hand-authored legacy override) — those keep the historical
 * "every slot" behavior, exactly as `selectedModeTargetSlots` does for spells.
 */
export function abilityModeTargetSlots(
  modes: AbilityModes,
  selection: readonly number[],
): number[] | undefined {
  const chosen = selection.map((index) => modes.options[index]);
  if (chosen.some((option) => option?.targetSlots === undefined)) return undefined;
  return [...new Set(chosen.flatMap((option) => option?.targetSlots ?? []))].sort((a, b) => a - b);
}

/** "Target creature gets +2/+2 …; Proliferate" — the human-readable label of a selection. */
export function abilityModeLabel(modes: AbilityModes, selection: readonly number[]): string {
  return selection
    .map((index) => modes.options[index]?.description ?? `mode ${index + 1}`)
    .join('; ');
}

/** The announced ability: the chosen modes' effects, with `modes` itself removed. */
export function abilityForModes(ability: Ability, selection: readonly number[]): Ability {
  const { modes, ...rest } = ability;
  if (modes === undefined) return ability;
  return {
    ...rest,
    effects: selection.flatMap((index) => modes.options[index]?.effects ?? []),
  };
}

/** Is `slot` announced under this selection? (`activeSlots` undefined: every slot is.) */
export function slotIsActive(activeSlots: readonly number[] | undefined, slot: number): boolean {
  return activeSlots === undefined || activeSlots.includes(slot);
}

/**
 * The selections whose announced targets can all be chosen (CR 700.2a-b). `optionsFor` returns
 * how many legal choices a slot has right now; a variable-count slot only needs its minimum.
 */
export function legalAbilityModeSelections(
  ability: Ability,
  optionsFor: (spec: TargetSpec, slot: number) => number,
): number[][] {
  const modes = ability.modes;
  if (modes === undefined) return [];
  return abilityModeSelections(modes).filter((selection) => {
    const activeSlots = abilityModeTargetSlots(modes, selection);
    return ability.targets.every((spec, slot) => {
      if (!slotIsActive(activeSlots, slot)) return true;
      const available = optionsFor(spec, slot);
      return spec.count !== undefined ? available >= spec.count.min : available > 0;
    });
  });
}
