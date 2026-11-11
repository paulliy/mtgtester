import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '@mtg/engine';
import { buildCardKnowledge, cardTraits } from './card-traits';

const cards = JSON.parse(
  readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];

function traits(name: string): ReturnType<typeof cardTraits> {
  const card = cards.find((c) => c.name === name);
  if (card === undefined) throw new Error(`${name} is not in the fixture`);
  return cardTraits(interpretCard(card));
}

describe('cardTraits', () => {
  it.each([
    ['Path to Exile', 'removal', 1],
    ['Swords to Plowshares', 'removal', 1],
    ['Beast Within', 'removal', 3],
    ['Lightning Bolt', 'removal', 1],
    ['Counterspell', 'counter', 2],
    ['Swan Song', 'counter', 1],
    ['Blasphemous Act', 'wipe', 9],
    ['Cultivate', 'ramp', 3],
    ['Rampant Growth', 'ramp', 2],
    ['Sol Ring', 'ramp', 1],
    ['Arcane Signet', 'ramp', 2],
    ['Harmonize', 'draw', 4],
    ['Brainstorm', 'draw', 1],
    ['Heroic Intervention', 'protection', 2],
  ] as const)('%s has the %s role and mana value %d', (name, role, manaValue) => {
    const t = traits(name);
    expect(t.roles).toContain(role);
    expect(t.manaValue).toBe(manaValue);
  });

  it('marks a removal spell target as hostile and a counterspell target as hostile', () => {
    expect(traits('Path to Exile').spellTargets).toEqual(['hostile']);
    expect(traits('Counterspell').spellTargets).toEqual(['hostile']);
  });

  it('treats a negative pump as hostile removal, not a friendly pump', () => {
    const grasp = {
      ...cards.find((c) => c.name === 'Lightning Bolt')!,
      name: 'Grasp of Darkness',
      oracleText: 'Target creature gets -4/-4 until end of turn.',
    } as OracleCard;
    const t = cardTraits(interpretCard(grasp));
    expect(t.spellTargets).toEqual(['hostile']);
    expect(t.roles).toContain('removal');
    expect(t.roles).not.toContain('pump');
  });

  it('records constant damage per target slot', () => {
    expect(traits('Lightning Bolt').spellDamage).toEqual([3]);
  });

  it("carries a selective sweeper's selector and a damage sweeper's amount", () => {
    const death = traits('Their Name Is Death');
    expect(death.roles).toContain('wipe');
    expect(death.wipeSelector).toEqual({
      kind: 'allOf',
      of: [
        { kind: 'type', value: 'Creature' },
        { kind: 'not', of: { kind: 'type', value: 'Artifact' } },
      ],
    });
    expect(traits('Blasphemous Act').wipeDamage).toBe(13);
  });

  it('does not call a counterspell removal', () => {
    expect(traits('Counterspell').roles).not.toContain('removal');
  });

  it('classifies most of the modeled fixture without throwing', () => {
    let withRoles = 0;
    let nonCreatureSpells = 0;
    for (const card of cards) {
      const def = interpretCard(card);
      if (!def.modeled || def.types.includes('Creature') || def.types.includes('Land')) continue;
      nonCreatureSpells++;
      if (cardTraits(def).roles.length > 0) withRoles++;
    }
    // A floor, not a target: most noncreature spells do something the bot can name.
    expect(withRoles / nonCreatureSpells).toBeGreaterThan(0.6);
  });
});

describe('buildCardKnowledge', () => {
  it('looks cards up by name, case-insensitively', () => {
    const defs = ['Sol Ring', 'Counterspell'].map((n) =>
      interpretCard(cards.find((c) => c.name === n)!),
    );
    const knowledge = buildCardKnowledge(defs);
    expect(knowledge('sol ring')?.roles).toContain('ramp');
    expect(knowledge('Counterspell')?.manaValue).toBe(2);
    expect(knowledge('Not A Card')).toBeUndefined();
  });
});
