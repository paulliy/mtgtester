/**
 * Sunforger is catalog-contained: the override restated Equip {2} after replacing
 * `activatedAbilities`, but current Oracle is Equip {3}.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('Sunforger (catalog containment)', () => {
  it('is explicitly unsupported for the Equip cost drift', () => {
    const card = oracle({
      oracleId: 'd1421070-a3cc-4af3-bf91-0f97372f4161',
      name: 'Sunforger',
      typeLine: 'Artifact — Equipment',
      manaCost: '{3}',
      power: null,
      toughness: null,
      oracleText:
        'Equipped creature gets +4/+0.\n{R}{W}, Unattach this Equipment: Search your library for a red or white instant card with mana value 4 or less and cast that card without paying its mana cost. Then shuffle.\nEquip {3}',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('\n')).toContain(
      'Equip {2} is authored; current Oracle is Equip {3}.',
    );
  });
});
