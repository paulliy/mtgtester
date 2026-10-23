import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import { deriveCardCapabilities } from '../../packages/engine/src/cards/capabilities';

export const HAND_DISCARD_CAPABILITIES = [
  'Ability.effects',
  'Ability.spell',
  'Ability.targets',
  'CardDefinition',
  'CardDefinition.manaCost',
  'CardDefinition.spellAbility',
  'Effect.revealHandAndDiscard',
  'ParsedManaCost',
  'Selector.allOf',
  'Selector.not',
  'Selector.type',
  'TargetSpec.player',
] as const;

/** Exact independent composition; neither a card-name exception nor a general discard grant. */
export function supportsBoundedHandDiscard(definition: CardDefinition): boolean {
  try {
    const cost = definition.manaCost;
    const ability = definition.spellAbility;
    const target = ability?.targets[0];
    const effect = ability?.effects[0];
    if (
      validateCardDefinition(definition).length !== 0 ||
      !definition.modeled ||
      definition.hasUnsupportedCost ||
      definition.types.length !== 1 ||
      definition.types[0] !== 'Sorcery' ||
      definition.supertypes.length !== 0 ||
      cost === null ||
      cost.generic !== 0 ||
      cost.colorless !== 0 ||
      (cost.x ?? 0) !== 0 ||
      (cost.hybrid?.length ?? 0) !== 0 ||
      (cost.phyrexian?.length ?? 0) !== 0 ||
      cost.colored.B !== 1 ||
      Object.entries(cost.colored).some(([symbol, amount]) => symbol !== 'B' && amount !== 0) ||
      ability?.kind !== 'spell' ||
      ability.targets.length !== 1 ||
      target?.kind !== 'player' ||
      target.controller !== 'opponent' ||
      Object.keys(target).some((key) => key !== 'kind' && key !== 'controller') ||
      ability.effects.length !== 1 ||
      effect?.op !== 'revealHandAndDiscard' ||
      effect.target !== 0 ||
      effect.filter?.kind !== 'allOf' ||
      effect.filter.of.length !== 2 ||
      Object.keys(effect).some((key) => !['op', 'target', 'filter'].includes(key))
    )
      return false;
    const excludedTypes = effect.filter.of
      .map((selector) =>
        selector.kind === 'not' && selector.of.kind === 'type' ? selector.of.value : null,
      )
      .sort();
    return (
      excludedTypes[0] === 'Creature' &&
      excludedTypes[1] === 'Land' &&
      deriveCardCapabilities(definition).every((capability) =>
        (HAND_DISCARD_CAPABILITIES as readonly string[]).includes(capability),
      )
    );
  } catch {
    return false;
  }
}
