import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '@mtg/engine';
import { buildCardKnowledge, cardTraits } from './card-traits';

const cards = JSON.parse(
  readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];

// Giant Growth and Shivan Dragon live only in the ranked fixture; loaded lazily so the
// whole-fixture test below still iterates the coverage cards alone.
let ranked: OracleCard[] | undefined;
function rankedCards(): OracleCard[] {
  ranked ??= (
    JSON.parse(
      readFileSync(new URL('../../fixtures/edhrec-pinned-oracle.json', import.meta.url), 'utf8'),
    ) as Array<{ card: OracleCard }>
  ).map((entry) => entry.card);
  return ranked;
}

function traits(name: string): ReturnType<typeof cardTraits> {
  const card = cards.find((c) => c.name === name) ?? rankedCards().find((c) => c.name === name);
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

  it('records what an ability that only strips keywords takes, and from which permanents', () => {
    expect(traits('Shadowspear').abilityKeywordStrip).toEqual([
      {
        selector: { kind: 'controller', who: 'opponents' },
        keywords: ['hexproof', 'indestructible'],
      },
      null,
    ]);
    expect(traits('Arcane Lighthouse').abilityKeywordStrip).toEqual([
      {
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Creature' },
            { kind: 'controller', who: 'opponents' },
          ],
        },
        keywords: ['hexproof', 'shroud'],
      },
    ]);
    expect(traits('Bonds of Mortality').abilityKeywordStrip?.[0]?.keywords).toEqual([
      'hexproof',
      'indestructible',
    ]);
    // An ability that does anything else is not a strip, and a card with none has no field.
    expect(traits('Lightning Greaves').abilityKeywordStrip).toBeUndefined();
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

  it('records damage a spell deals to every player, its controller included', () => {
    expect(traits('Earthquake').damagesEachPlayer).toBe('X');
    expect(traits('Hurricane').damagesEachPlayer).toBe('X');
    expect(traits('Flame Rift').damagesEachPlayer).toBe(4);
    expect(traits('Volcanic Fallout').damagesEachPlayer).toBe(2);
    // Opponent-only burn, a creature sweeper and a permanent with an each-player ability do not.
    expect(traits('Boltwave').damagesEachPlayer).toBeUndefined();
    expect(traits('Blasphemous Act').damagesEachPlayer).toBeUndefined();
    expect(traits('Pestilence Demon').damagesEachPlayer).toBeUndefined();
  });

  it('records pump and mana facts for ADR 0043', () => {
    expect(traits('Giant Growth').spellPump).toEqual([{ power: 3, toughness: 3 }]);
    expect(traits('Overrun').massPump).toEqual({ power: 3, toughness: 3, keywords: ['trample'] });
    expect(traits('Shivan Dragon').abilitySelfPump).toEqual([{ power: 1, toughness: 0 }]);
    expect(traits('Sol Ring').manaUnits).toEqual([['C'], ['C']]);
    expect(traits('Command Tower').manaUnits).toBeUndefined();
  });

  it('marks destroy and exile removal as hard, but not a blink, damage or a bounce (ADR 0044)', () => {
    expect(traits('Swords to Plowshares').hardRemoval).toBe(true);
    expect(traits('Path to Exile').hardRemoval).toBe(true);
    expect(traits('Banishing Light').hardRemoval).toBe(true);
    expect(traits('Flickerwisp').hardRemoval).toBeUndefined();
    expect(traits('Lightning Bolt').hardRemoval).toBeUndefined();
  });

  it('tells an unclassified card from one with nothing notable (ADR 0044)', () => {
    // Fog-like prevention has no role pattern; Brainstorm is draw plus card selection.
    expect(traits('Darkness').unclassified).toBe(true);
    expect(traits('Brainstorm').unclassified).toBeUndefined();
    expect(traits('Swords to Plowshares').unclassified).toBeUndefined();
    // A vanilla creature and a basic land have no effect ops at all.
    expect(traits('Grizzly Bears').unclassified).toBeUndefined();
    expect(traits('Forest').unclassified).toBeUndefined();
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

describe('flash', () => {
  const reviewed = (
    JSON.parse(
      readFileSync(new URL('../../fixtures/flash-creatures.json', import.meta.url), 'utf8'),
    ) as { cards: Array<{ name: string; label: 'flash' | 'grants-only' }> }
  ).cards;

  it('flags exactly the reviewed creatures that have flash, not those that only grant it', () => {
    const wrong = reviewed.filter((c) => (traits(c.name).flash === true) !== (c.label === 'flash'));
    expect(wrong).toEqual([]);
    expect(reviewed.filter((c) => c.label === 'flash').length).toBe(155);
  });

  it('flags no other creature in the coverage pool', () => {
    const listed = new Set(reviewed.map((c) => c.name));
    const extra = cards
      .filter((c) => c.typeLine.includes('Creature') && !listed.has(c.name))
      .filter((c) => cardTraits(interpretCard(c)).flash === true)
      .map((c) => c.name);
    expect(extra).toEqual([]);
  });
});
