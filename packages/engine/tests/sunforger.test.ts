/**
 * Sunforger was catalog-contained: the override restated Equip {2} after replacing
 * `activatedAbilities`, but current Oracle is Equip {3}. Coverage PR05.15 deleted the fail-closed
 * registration; the interpreter now reads the whole card. This file pins that the containment is
 * gone and the card is modeled on its own. Behavior is covered in `pr05-card-coverage.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import { oracle } from './fixtures';

describe('Sunforger (restored in coverage PR05)', () => {
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

  it('is modeled by the interpreter with no override and no Equip {2} drift', () => {
    expect(getOverride(card.oracleId)).toBeUndefined();
    expect(getOverride(fixtureOracleId(card.name))).toBeUndefined();
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    const equip = def.activatedAbilities.find(
      (ability) => ability.ability.description === 'Equip {3}',
    );
    expect(equip?.costs).toEqual([
      {
        kind: 'mana',
        cost: { generic: 3, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
      },
    ]);
  });
});
