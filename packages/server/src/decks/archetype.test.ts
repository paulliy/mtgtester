/**
 * The deterministic archetype classifier (brief §8.4, ADR 0022 §5).
 *
 * Two kinds of coverage here. Synthetic decks isolate one signal each, so a threshold change
 * shows up as a specific axis moving rather than as "some deck tags differently now". The
 * Ur-Dragon fixture is the real-world check — 93 committed `OracleCard`s, no Scryfall bulk file
 * needed, so it runs in CI.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { identityName, inferArchetype } from './archetype';

function card(overrides: Partial<OracleCard> & { name: string }): OracleCard {
  return {
    oracleId: `oracle-${overrides.name}`,
    scryfallId: `scry-${overrides.name}`,
    manaCost: '{1}',
    cmc: 2,
    colors: [],
    colorIdentity: [],
    typeLine: 'Creature — Human',
    supertypes: [],
    types: ['Creature'],
    subtypes: ['Human'],
    oracleText: '',
    power: '2',
    toughness: '2',
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
    ...overrides,
  };
}

function land(n: number): OracleCard {
  return card({
    name: `Forest ${n}`,
    typeLine: 'Basic Land — Forest',
    types: ['Land'],
    supertypes: ['Basic'],
    subtypes: ['Forest'],
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
    isBasicLand: true,
  });
}

function many(
  count: number,
  make: (index: number) => OracleCard,
): Array<{ card: OracleCard; quantity: number }> {
  return Array.from({ length: count }, (_, index) => ({ card: make(index), quantity: 1 }));
}

/** Signal-free filler: no creature subtype to read as a tribe, no theme text, no keywords. */
function filler(n: number): OracleCard {
  return card({
    name: `Filler ${n}`,
    typeLine: 'Enchantment',
    types: ['Enchantment'],
    subtypes: [],
    cmc: 3,
    power: null,
    toughness: null,
  });
}

const LANDS = many(30, (i) => land(i));
const VANILLA_COMMANDER = card({ name: 'Plain General', typeLine: 'Legendary Creature — Human' });

function tagFor(
  cards: Array<{ card: OracleCard; quantity: number }>,
  commander: OracleCard = VANILLA_COMMANDER,
) {
  return inferArchetype({ commanders: [commander], cards, colorIdentity: ['G'] });
}

describe('identityName — what a Commander player actually calls the colours', () => {
  it('names every guild, shard and wedge', () => {
    expect(identityName([])).toBe('Colorless');
    expect(identityName(['G'])).toBe('Mono-Green');
    expect(identityName(['R', 'G'])).toBe('Gruul');
    expect(identityName(['W', 'U'])).toBe('Azorius');
    expect(identityName(['U', 'B', 'G'])).toBe('Sultai');
    expect(identityName(['W', 'B', 'G'])).toBe('Abzan');
    expect(identityName(['W', 'U', 'B', 'R', 'G'])).toBe('Five-Color');
  });

  it('uses the "non-X" convention for four colours rather than the Nephilim names', () => {
    // Technically correct and universally unrecognised: nobody says "Yore-Tiller".
    expect(identityName(['W', 'U', 'B', 'R'])).toBe('Non-Green');
    expect(identityName(['U', 'B', 'R', 'G'])).toBe('Non-White');
  });

  it('is insensitive to the order colours are supplied in', () => {
    expect(identityName(['G', 'W', 'U'])).toBe(identityName(['U', 'W', 'G']));
  });
});

describe('strategy axis', () => {
  it('reads a cheap creature deck with aggressive keywords as aggro', () => {
    const result = tagFor([
      ...LANDS,
      ...many(40, (i) => card({ name: `Beater ${i}`, cmc: 2, keywords: ['Haste', 'Trample'] })),
    ]);

    expect(result.strategy).toBe('aggro');
  });

  it('reads a low-creature interaction pile as control', () => {
    const result = tagFor([
      ...LANDS,
      ...many(12, (i) =>
        card({
          name: `Counter ${i}`,
          typeLine: 'Instant',
          types: ['Instant'],
          subtypes: [],
          oracleText: 'Counter target spell.',
        }),
      ),
      ...many(8, (i) =>
        card({
          name: `Removal ${i}`,
          typeLine: 'Instant',
          types: ['Instant'],
          subtypes: [],
          oracleText: 'Destroy target creature.',
        }),
      ),
      ...many(6, (i) =>
        card({
          name: `Wipe ${i}`,
          typeLine: 'Sorcery',
          types: ['Sorcery'],
          subtypes: [],
          oracleText: 'Destroy all creatures.',
        }),
      ),
      ...many(4, (i) => card({ name: `Blocker ${i}` })),
    ]);

    expect(result.strategy).toBe('control');
  });

  it('reads denial effects as stax before they look like control', () => {
    const result = tagFor([
      ...LANDS,
      ...many(12, (i) =>
        card({
          name: `Tax ${i}`,
          typeLine: 'Enchantment',
          types: ['Enchantment'],
          subtypes: [],
          oracleText: "Creatures your opponents control don't untap during their untap step.",
        }),
      ),
      ...many(10, (i) =>
        card({
          name: `Removal ${i}`,
          typeLine: 'Instant',
          types: ['Instant'],
          subtypes: [],
          oracleText: 'Destroy target creature.',
        }),
      ),
      ...many(8, (i) => card({ name: `Body ${i}` })),
    ]);

    expect(result.strategy).toBe('stax');
  });

  it('reads a tutor-and-draw shell as combo', () => {
    const result = tagFor([
      ...LANDS,
      ...many(10, (i) =>
        card({
          name: `Tutor ${i}`,
          typeLine: 'Sorcery',
          types: ['Sorcery'],
          subtypes: [],
          oracleText: 'Search your library for a card, then shuffle and put that card on top.',
        }),
      ),
      ...many(14, (i) =>
        card({
          name: `Draw ${i}`,
          typeLine: 'Instant',
          types: ['Instant'],
          subtypes: [],
          oracleText: 'Draw two cards.',
        }),
      ),
      ...many(16, (i) => card({ name: `Piece ${i}` })),
    ]);

    expect(result.strategy).toBe('combo');
  });

  it('reads expensive spells behind mana acceleration as ramp', () => {
    const result = tagFor([
      ...LANDS,
      ...many(18, (i) =>
        card({
          name: `Rock ${i}`,
          typeLine: 'Artifact',
          types: ['Artifact'],
          subtypes: [],
          cmc: 2,
          oracleText: '{T}: Add {G}.',
        }),
      ),
      ...many(22, (i) => card({ name: `Fatty ${i}`, cmc: 7 })),
    ]);

    expect(result.strategy).toBe('ramp');
  });

  it('falls back to midrange rather than forcing a deck into an axis it does not fit', () => {
    const result = tagFor([...LANDS, ...many(40, (i) => card({ name: `Value ${i}`, cmc: 3 }))]);

    expect(result.strategy).toBe('midrange');
  });

  it('does not count lands that merely tap for mana as ramp', () => {
    // Every dual land says "Add {G}". Scoring those as ramp made every deck a ramp deck.
    const manaLands = many(30, (i) =>
      card({
        name: `Dual ${i}`,
        typeLine: 'Land',
        types: ['Land'],
        subtypes: [],
        manaCost: null,
        cmc: 0,
        power: null,
        toughness: null,
        oracleText: '{T}: Add {G} or {W}.',
      }),
    );
    const result = tagFor([...manaLands, ...many(40, (i) => card({ name: `Value ${i}`, cmc: 3 }))]);

    expect(result.features.ramp).toBe(0);
    expect(result.strategy).toBe('midrange');
  });
});

describe('theme axis', () => {
  it("lets the commander's own text decide the theme", () => {
    // Twelve token mentions would be noise in 99 cards; on the commander it is the deck's plan.
    const commander = card({
      name: 'Token Maker',
      typeLine: 'Legendary Creature — Human',
      oracleText: 'At the beginning of your end step, create a 1/1 white Soldier creature token.',
    });
    const result = tagFor([...LANDS, ...many(40, (i) => filler(i))], commander);

    expect(result.theme).toBe('tokens');
    expect(result.tag).toBe('Mono-Green tokens midrange');
  });

  it('names a tribe when the commander shares it and the creature base is concentrated', () => {
    const elfGeneral = card({
      name: 'Elf General',
      typeLine: 'Legendary Creature — Elf Druid',
      subtypes: ['Elf', 'Druid'],
    });
    const result = tagFor(
      [
        ...LANDS,
        ...many(16, (i) =>
          card({ name: `Elf ${i}`, typeLine: 'Creature — Elf', subtypes: ['Elf'] }),
        ),
        ...many(8, (i) => card({ name: `Other ${i}`, cmc: 3 })),
      ],
      elfGeneral,
    );

    expect(result.features.commanderSharesTopSubtype).toBe(true);
    expect(result.theme).toBe('elf tribal');
  });

  it('refuses to call a bare majority tribal when the commander does not share it', () => {
    // Half the creatures being Wizards is how a counters deck gets mislabelled "wizard tribal".
    const result = tagFor([
      ...LANDS,
      ...many(12, (i) =>
        card({ name: `Wizard ${i}`, typeLine: 'Creature — Wizard', subtypes: ['Wizard'] }),
      ),
      ...many(10, (i) => card({ name: `Other ${i}`, cmc: 3 })),
    ]);

    expect(result.features.commanderSharesTopSubtype).toBe(false);
    expect(result.theme).not.toBe('wizard tribal');
  });

  it('omits the theme entirely when nothing is dominant', () => {
    const result = tagFor([...LANDS, ...many(40, (i) => filler(i))]);

    expect(result.theme).toBeNull();
    expect(result.tag).toBe('Mono-Green midrange');
  });
});

describe('determinism (brief §4 — the same input must give the same answer)', () => {
  it('returns an identical tag when the same decklist is classified twice', () => {
    const cards = [
      ...LANDS,
      ...many(40, (i) => card({ name: `Beater ${i}`, cmc: 2, keywords: ['Haste'] })),
    ];

    expect(tagFor(cards).tag).toBe(tagFor(cards).tag);
  });

  it('is independent of the order the decklist was written in', () => {
    const cards = [
      ...LANDS,
      ...many(9, (i) => card({ name: `Elf ${i}`, typeLine: 'Creature — Elf', subtypes: ['Elf'] })),
      ...many(9, (i) =>
        card({ name: `Goblin ${i}`, typeLine: 'Creature — Goblin', subtypes: ['Goblin'] }),
      ),
    ];

    // A tie on subtype count must not resolve by insertion order, or the same deck tags
    // differently depending on how the user happened to type it out.
    expect(tagFor(cards).tag).toBe(tagFor([...cards].reverse()).tag);
  });
});

describe('a real committed decklist', () => {
  it('reads the Ur-Dragon fixture as five-colour dragon tribal ramp', () => {
    const cards = JSON.parse(
      readFileSync(resolve('packages/engine/tests/fixtures/urdragon-oracle.json'), 'utf8'),
    ) as OracleCard[];
    const commander = cards.find((entry) => entry.name.includes('Ur-Dragon'));
    expect(commander).toBeDefined();

    const result = inferArchetype({
      commanders: [commander as OracleCard],
      cards: cards
        .filter((entry) => entry !== commander)
        .map((entry) => ({ card: entry, quantity: 1 })),
      colorIdentity: ['W', 'U', 'B', 'R', 'G'],
    });

    expect(result.tag).toBe('Five-Color dragon tribal ramp');
    // 15 real accelerants behind a 4.2 average mana value — the reason it reads as ramp.
    expect(result.features.ramp).toBe(15);
    expect(result.features.averageManaValue).toBeGreaterThan(4);
  });
});
