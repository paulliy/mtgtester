import type { Ability } from './ability';

/**
 * Whether an ability acts on its source permanent as "it" — sacrifices it, has it fight, or
 * affects it through a `'source'` referent (Kogla's "~ gains indestructible"). Such an ability
 * remembers the exact source object as it goes on the stack, so a source that left and returned
 * in response is a new object the ability no longer affects (CR 400.7).
 */
export function actsOnItsSourcePermanent(ability: Ability): boolean {
  return ability.effects.some((effect) => {
    if (
      effect.op === 'sacrificeSourceThenReflexive' ||
      effect.op === 'mayPayManaAndSacrificeSource'
    )
      return true;
    const refs = effect as { target?: unknown; first?: unknown; second?: unknown; a?: unknown };
    return (
      refs.target === 'source' ||
      refs.first === 'source' ||
      refs.second === 'source' ||
      refs.a === 'source'
    );
  });
}

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
