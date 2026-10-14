import type { EngineStackObject } from '../state/types';

/** CR 115.9a counts targeting occurrences, including illegal targets and repeated identities. */
export function spellTargetOccurrences(
  spell: EngineStackObject,
): Array<{ slot: number; ordinal?: number; id: string }> {
  return (spell.ability?.targets ?? []).flatMap((spec, slot) => {
    if (spec.count !== undefined)
      return (spell.countTargets?.[slot] ?? []).map((id, ordinal) => ({ slot, ordinal, id }));
    const id = spell.targets[slot];
    return id === undefined || id === '' ? [] : [{ slot, id }];
  });
}
