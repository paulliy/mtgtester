import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('Draconic Destruction executable overrides', () => {
  it('models Return to Nature as three concrete targeted removal modes', () => {
    const def = interpretCard(
      oracle({
        oracleId: '777b8ec4-a783-4297-96b7-4f200d0eb734',
        name: 'Return to Nature',
        typeLine: 'Instant',
        manaCost: '{1}{G}',
        oracleText:
          'Choose one —\n• Destroy target artifact.\n• Destroy target enchantment.\n• Exile target card from a graveyard.',
      }),
    );

    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.modes).toEqual({
      minChoices: 1,
      maxChoices: 1,
      options: [
        { effects: [{ op: 'destroy', target: 0 }], description: 'Destroy target artifact' },
        { effects: [{ op: 'destroy', target: 1 }], description: 'Destroy target enchantment' },
        { effects: [{ op: 'exile', target: 2 }], description: 'Exile target card from a graveyard' },
      ],
    });
  });
});
