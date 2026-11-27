import { describe, expect, it } from 'vitest';
import type { LegalAction } from './protocol';
import { rowYieldIsUnambiguous, yieldChoiceKeys, yieldedAbilityCount } from './sourceYields';

let nextId = 0;
function ability(cardId: string, abilityIndex: number, description: string): LegalAction {
  return {
    id: nextId++,
    type: 'activateAbility',
    description,
    interaction: { kind: 'source', sourceId: `obj-${cardId}`, sourceCardId: cardId, abilityIndex },
  };
}
function spell(objectId: string): LegalAction {
  return {
    id: nextId++,
    type: 'castSpell',
    description: 'Cast it',
    interaction: { kind: 'source', sourceId: objectId },
  };
}

// Liliana, Waker of the Dead at five loyalty: the +1 and the −3 are both legal.
const liliana = [
  ability('liliana', 0, 'Liliana: Each player discards'),
  ability('liliana', 1, 'Liliana: Target creature gets -X/-X'),
];

describe('a "Playable now" row yield', () => {
  it('is withheld on a planeswalker with two legal loyalty abilities', () => {
    expect(yieldChoiceKeys(liliana)).toEqual(new Set(['liliana:0', 'liliana:1']));
    expect(rowYieldIsUnambiguous(liliana)).toBe(false);
  });

  it('is offered when the source has one choice, however many modes or X values it has', () => {
    const xFamily = [0, 1, 2].map(() => ability('fireball-rod', 0, 'Deal X damage'));
    expect(rowYieldIsUnambiguous(xFamily)).toBe(true);
    expect(rowYieldIsUnambiguous([spell('hand-1')])).toBe(true);
  });

  it('is withheld on a card that can be both cast and activated from hand', () => {
    const cycler = [spell('obj-cycler'), ability('cycler', 0, 'Cycling')];
    expect(rowYieldIsUnambiguous(cycler)).toBe(false);
  });
});

describe('the yielded-ability count on a row', () => {
  it("counts this card's yielded abilities and nobody else's", () => {
    const ignored = [
      { key: 'liliana:0', label: 'Liliana: Each player discards', mode: 'smart' as const },
      { key: 'other-card:0', label: 'Something else' },
      { key: 'spell:obj-liliana', label: 'A spell preference' },
    ];
    // Only the −3 is still offered once the +1 is yielded; the row says the +1 is held back.
    expect(yieldedAbilityCount([liliana[1]!], ignored)).toBe(1);
    expect(yieldedAbilityCount([ability('third-card', 0, 'Tap')], ignored)).toBe(0);
  });
});
