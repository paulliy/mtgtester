import { describe, expect, it } from 'vitest';
import { boundedMultiplayerPermanent } from '../../../scripts/contracts/bounded-multiplayer-permanents';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { deriveOverloadAbility } from '../src/cards/overload';
import { boundedChoiceSpell } from '../../../scripts/contracts/bounded-choice-spells';

describe('distinct-player modal authoring boundaries', () => {
  it('accepts complete same-domain player constraints and rejects partial graphs that could strand later choices', () => {
    const definition = boundedMultiplayerPermanent('distinct-death');
    expect(validateCardDefinition(definition)).toEqual([]);
    definition.triggers[0]!.targets[0]!.differentPlayerTargetSlots = [1];
    definition.triggers[0]!.targets[1]!.differentPlayerTargetSlots = [0];
    delete definition.triggers[0]!.targets[2]!.differentPlayerTargetSlots;
    expect(
      validateCardDefinition(definition).some((issue) =>
        issue.path.includes('differentPlayerTargetSlots'),
      ),
    ).toBe(true);
  });
  it('rejects distinct-player constraints outside nonrepeatable triggered modes', () => {
    for (const variant of ['spell', 'activated', 'repeatable'] as const) {
      const definition = boundedMultiplayerPermanent('distinct-combat');
      const ability = definition.triggers[0]!;
      if (variant === 'repeatable') ability.modes!.repeatable = true;
      else ability.kind = variant;
      expect(
        validateCardDefinition(definition).some((issue) =>
          issue.message.includes('distinct player target slots'),
        ),
      ).toBe(true);
    }
  });
  it('rejects differing target domains and malformed peer indices', () => {
    for (const peers of [
      [0, 1],
      [1, 1],
      [1, 9],
    ]) {
      const definition = boundedMultiplayerPermanent('distinct-death');
      definition.triggers[0]!.targets[0]!.differentPlayerTargetSlots = peers;
      expect(validateCardDefinition(definition).length).toBeGreaterThan(0);
    }
    const definition = boundedMultiplayerPermanent('distinct-combat');
    definition.triggers[0]!.targets[1]!.controller = 'opponent';
    expect(validateCardDefinition(definition).length).toBeGreaterThan(0);
  });
  it('lowers only the known untargeted exile-search composition for overload', () => {
    const definition = boundedChoiceSpell('exile-search');
    expect(deriveOverloadAbility(definition.spellAbility)).toEqual(
      definition.alternativeCasts![0]!.ability,
    );
    definition.spellAbility!.targets[0]!.filter = { kind: 'type', value: 'Creature' };
    expect(deriveOverloadAbility(definition.spellAbility)).toBeNull();
  });
});
