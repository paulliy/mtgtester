import type { ManaAbilitySpec } from './ability';

/** These symbol queries remain constant while supported mana activation costs/riders run. */
export function activationInvariantProduction(ability: ManaAbilitySpec): boolean {
  return (
    ability.amount === undefined &&
    ability.conditionalUnits === undefined &&
    (ability.dynamic === undefined ||
      ability.dynamic === 'commanderIdentity' ||
      ability.dynamic === 'chosenColor')
  );
}
