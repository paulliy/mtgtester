/**
 * Cataloguing the remaining inline `TokenSpec` literals surfaced two more bugs of the same class
 * fixed in the previous pass (mismatched Soldier colors, a costless Treasure): a Necron Warrior
 * token with the wrong colors and an extra subtype, and a catalog entry that was wrong from the
 * moment it was added.
 */

import { describe, expect, it } from 'vitest';
import { getOverride } from '../src/cards/overrides';
import { THOPTER_1_1_FLYING } from '../src/cards/tokens';

describe('Night Scythe', () => {
  it('creates a black Necron Warrior, not a colorless Necron Warrior-Warrior', () => {
    // The card's own handled line reads "2/2 black Necron Warrior artifact creature token" — the
    // hand-written spec had colors: [] and subtypes: ['Necron', 'Warrior'], disagreeing with the
    // catalog's NECRON_WARRIOR_2_2 on both fields for the same printed token.
    const def = getOverride('dea9741a-3360-4a17-aeea-a854e2174d25');
    const spec = def?.def.triggers?.[0]?.effects.find((e) => e.op === 'createToken');
    expect(spec).toBeDefined();
    const token = (spec as { spec: { colors: string[]; subtypes: string[]; typeLine: string } }).spec;
    expect(token.colors).toEqual(['B']);
    expect(token.subtypes).toEqual(['Necron']);
    expect(token.typeLine).toBe('Artifact Creature — Necron');
  });
});

describe('Thopter token catalog entry', () => {
  it('is colorless, per every card that prints it', () => {
    // Added to the catalog with colors: ['U'] in an earlier pass and went uncaught because no
    // override referenced the const yet. living-energy.ts's own handledLines say, verbatim and
    // repeatedly, "1/1 colorless Thopter artifact creature token with flying".
    expect(THOPTER_1_1_FLYING.colors).toEqual([]);
  });

  it('is the same token wherever a card creates a Thopter', () => {
    const ids = [
      '7f268b15-ac92-4e98-821b-78d15d9285d9', // Loyal Apprentice
      'aaadfe41-b2be-4183-b45e-a70e53a59d2e', // Retrofitter Foundry
      'f82da236-e567-4221-a0bc-439a0c7e2b03', // Whirler Virtuoso
    ];
    const specs = ids
      .map((id) => getOverride(id))
      .flatMap((o) => [...(o?.def.triggers ?? []), ...(o?.def.activatedAbilities?.map((a) => a.ability) ?? [])])
      .flatMap((a) => a.effects)
      .filter((e) => e.op === 'createToken' && (e as { spec: { name?: string } }).spec.name === 'Thopter')
      .map((e) => (e as { spec: unknown }).spec);

    // Loyal Apprentice's Thopter enters hasty (`{ ...THOPTER_1_1_FLYING, grantHasteUntilEot: true }`)
    // — a legitimate per-card spread, not a divergence — so compare on the catalog's own fields.
    expect(specs.length).toBeGreaterThanOrEqual(3);
    for (const spec of specs) expect(spec).toMatchObject(THOPTER_1_1_FLYING);
  });
});
