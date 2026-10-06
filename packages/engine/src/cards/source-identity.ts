import type { Ability } from './ability';

/**
 * Whether an ability acts on the object that fired it as "it" (Frontier Siege's "you may have it
 * fight"). Such a trigger remembers that exact object, so one that left and returned in response
 * is a new object the ability no longer affects (CR 400.7).
 */
export function actsOnItsTriggerObject(ability: Ability): boolean {
  return ability.effects.some((effect) => {
    const refs = effect as { target?: unknown; first?: unknown; second?: unknown; a?: unknown };
    return (
      refs.target === 'triggerObject' ||
      refs.first === 'triggerObject' ||
      refs.second === 'triggerObject' ||
      refs.a === 'triggerObject'
    );
  });
}
