/**
 * Frontier Siege is catalog-contained: the Dragons fight is optional but still requires a
 * target creature you don't control.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('Frontier Siege (catalog containment)', () => {
  it('is explicitly unsupported for optional fight targeting', () => {
    const card = oracle({
      oracleId: '4cfaa5cf-cc3d-49a7-9544-38a8bb7e9ec1',
      name: 'Frontier Siege',
      typeLine: 'Enchantment',
      manaCost: '{3}{G}',
      oracleText:
        "As this enchantment enters, choose Khans or Dragons.\n• Khans — At the beginning of each of your main phases, add {G}{G}.\n• Dragons — Whenever a creature you control with flying enters, you may have it fight target creature you don't control.",
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('\n')).toContain(
      "The Dragons fight option still requires a target creature you don't control.",
    );
  });
});
