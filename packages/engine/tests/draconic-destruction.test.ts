import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('Draconic Destruction executable overrides', () => {
  it('models choose-one with per-mode targets (coverage PR01)', () => {
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
    expect(def.spellAbility?.modes?.options.map((option) => option.targetSlots)).toEqual([
      [0],
      [1],
      [2],
    ]);
  });
});
