import { describe, it, expect } from 'vitest';
import { parseTypeLine, toOracleCard, type RawScryfallCard } from './scryfall';

describe('parseTypeLine', () => {
  it('splits supertypes, types, and subtypes', () => {
    expect(parseTypeLine('Legendary Creature — Elf Druid')).toEqual({
      supertypes: ['Legendary'],
      types: ['Creature'],
      subtypes: ['Elf', 'Druid'],
    });
  });
  it('handles a type line with no subtypes', () => {
    expect(parseTypeLine('Instant')).toEqual({ supertypes: [], types: ['Instant'], subtypes: [] });
  });
  it('parses the front face of a double-faced type line', () => {
    expect(parseTypeLine('Basic Land — Forest // Creature — Elemental').types).toEqual(['Land']);
  });
});

describe('toOracleCard', () => {
  it('projects the fields the pipeline needs and flags basic lands', () => {
    const raw: RawScryfallCard = {
      id: 's1',
      oracle_id: 'o1',
      name: 'Forest',
      type_line: 'Basic Land — Forest',
      color_identity: ['G'],
      colors: [],
      cmc: 0,
      legalities: { commander: 'legal' },
    };
    const card = toOracleCard(raw);
    expect(card?.isBasicLand).toBe(true);
    expect(card?.colorIdentity).toEqual(['G']);
    expect(card?.manaCost).toBeNull();
  });

  it('falls back to the front face for a modal DFC mana cost', () => {
    const raw: RawScryfallCard = {
      id: 's2',
      oracle_id: 'o2',
      name: 'Malakir Rebirth // Malakir Mire',
      layout: 'modal_dfc',
      type_line: 'Instant // Land',
      mana_cost: '',
      cmc: 1,
      color_identity: ['B'],
      card_faces: [
        { name: 'Malakir Rebirth', mana_cost: '{B}', type_line: 'Instant' },
        { name: 'Malakir Mire', mana_cost: '', type_line: 'Land' },
      ],
    };
    expect(toOracleCard(raw)?.manaCost).toBe('{B}');
  });

  it('drops non-game entries (tokens) and cards without an oracle id', () => {
    expect(toOracleCard({ id: 't', oracle_id: 'x', name: 'Goblin', layout: 'token' })).toBeNull();
    expect(toOracleCard({ id: 'n', name: 'Nameless' } as RawScryfallCard)).toBeNull();
  });
});
