import type { ObjectId } from '@mtg/shared';
import type { Ability } from '../cards/ability';
import { evaluateValueIn } from '../effects/values';
import type { GameContext } from '../state/types';
import type { TargetContext } from './context';
import { targetCandidates, withinTotalManaValue } from './legality';

export type CountedTargetChoices = Readonly<Record<number, readonly ObjectId[]>>;

/**
 * Prove the still-required count minima and a whole payment completion together. Each count
 * slot is one targeting occurrence: duplicates are forbidden inside it, not across clauses.
 */
export function countTargetsCanComplete(
  ctx: GameContext,
  ability: Ability,
  context: TargetContext & { x?: number },
  prefix: CountedTargetChoices = {},
  activeSlots?: readonly number[],
  payable: (chosen: CountedTargetChoices) => boolean = () => true,
): boolean {
  const slots = ability.targets.flatMap((spec, slot) =>
    spec.count === undefined || (activeSlots !== undefined && !activeSlots.includes(slot))
      ? []
      : [{ spec, slot }],
  );
  const choices: Record<number, readonly ObjectId[]> = {};
  function search(index: number): boolean {
    const entry = slots[index];
    if (entry === undefined) return payable(choices);
    const { spec, slot } = entry;
    const picked = [...(prefix[slot] ?? [])];
    const division = ability.effects.find(
      (effect) => effect.op === 'dealDamageDivided' && effect.targetSlot === slot,
    );
    const maximum = Math.min(
      spec.count!.max,
      division?.op === 'dealDamageDivided'
        ? evaluateValueIn(ctx, division.total, {
            controllerId: context.controllerId,
            ...(context.sourceCardId === undefined ? {} : { sourceCardId: context.sourceCardId }),
            x: context.x ?? 0,
          })
        : Infinity,
    );
    const candidates = targetCandidates(ctx, spec, { ...context, phase: 'announcement' });
    if (
      picked.length > maximum ||
      new Set(picked).size !== picked.length ||
      picked.some((id) => !candidates.includes(id))
    )
      return false;
    const budget = spec.totalManaValueAtMost;
    if (
      budget !== undefined &&
      picked.some(
        (id, offset) =>
          !withinTotalManaValue(ctx, spec, picked.slice(0, offset), [id]).includes(id),
      )
    )
      return false;
    function add(next: number): boolean {
      if (picked.length >= spec.count!.min) {
        choices[slot] = [...picked];
        const result = search(index + 1);
        delete choices[slot];
        return result;
      }
      if (picked.length >= maximum) return false;
      for (let i = next; i < candidates.length; i++) {
        const id = candidates[i]!;
        if (picked.includes(id) || !withinTotalManaValue(ctx, spec, picked, [id]).includes(id))
          continue;
        picked.push(id);
        if (add(i + 1)) return true;
        picked.pop();
      }
      return false;
    }
    return add(0);
  }
  return search(0);
}

export interface TargetMenu {
  slot: number;
  options: ObjectId[];
}

/** A menu's Cartesian target responses must all admit a full targeting/payment completion. */
export function legalTargetMenus(
  ctx: GameContext,
  ability: Ability,
  context: TargetContext & { x?: number },
  activeSlots?: readonly number[],
  payable: (ordinary: readonly ObjectId[], counted: CountedTargetChoices) => boolean = () => true,
): TargetMenu[][] {
  const slots = ability.targets.flatMap((spec, slot) =>
    spec.count !== undefined || (activeSlots !== undefined && !activeSlots.includes(slot))
      ? []
      : [{ spec, slot }],
  );
  const valid: ObjectId[][] = [];
  const ordinary: ObjectId[] = [];
  function search(index: number): void {
    const entry = slots[index];
    if (entry === undefined) {
      if (
        countTargetsCanComplete(
          ctx,
          ability,
          { ...context, chosenTargets: ordinary },
          {},
          activeSlots,
          (counted) => payable(ordinary, counted),
        )
      )
        valid.push([...ordinary]);
      return;
    }
    for (const id of targetCandidates(ctx, entry.spec, {
      ...context,
      chosenTargets: ordinary,
      phase: 'announcement',
    })) {
      ordinary[entry.slot] = id;
      search(index + 1);
    }
    delete ordinary[entry.slot];
  }
  search(0);
  if (valid.length === 0) return [];
  const menu = slots.map(({ slot }) => ({
    slot,
    options: [...new Set(valid.map((targets) => targets[slot]!))],
  }));
  if (valid.length === menu.reduce((size, slot) => size * slot.options.length, 1)) return [menu];
  // Dependent domains and collective taxes cannot be expressed as independent choices. Each
  // smaller menu fixes one valid assignment; no illegal cross-product is advertised.
  return valid.map((targets) => slots.map(({ slot }) => ({ slot, options: [targets[slot]!] })));
}
