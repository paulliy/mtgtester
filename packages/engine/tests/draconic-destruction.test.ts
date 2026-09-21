import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('Draconic Destruction executable overrides', () => {
  it('is catalog-contained because choose-one still requires every mode target', () => {
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

    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('\n')).toContain(
      'Choose-one still requires targets for every mode.',
    );
  });
});
