/**
 * Frontier Siege is modeled (coverage PR01): the as-enters mode, the Khans mana trigger, and the
 * optional Dragons fight. Behavior is covered in pr01-card-coverage.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('Frontier Siege', () => {
  it('models the as-enters mode and both mode abilities', () => {
    const card = oracle({
      oracleId: '4cfaa5cf-cc3d-49a7-9544-38a8bb7e9ec1',
      name: 'Frontier Siege',
      typeLine: 'Enchantment',
      manaCost: '{3}{G}',
      oracleText:
        "As this enchantment enters, choose Khans or Dragons.\n• Khans — At the beginning of each of your main phases, add {G}{G}.\n• Dragons — Whenever a creature you control with flying enters, you may have it fight target creature you don't control.",
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.entersChoosingOption?.options?.map((option) => option.key)).toEqual([
      'Khans',
      'Dragons',
    ]);
    expect(def.triggers).toHaveLength(2);
  });
});
