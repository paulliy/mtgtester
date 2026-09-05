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

  it('carries the second face separately as backFace, unmerged with the front', () => {
    // Every OTHER field on OracleCard is the front face's projection (via faceFallback); this
    // is the one place a second face's own characteristics survive at all, which is what
    // interpret.ts's modal-DFC-land handling (Pathway lands) needs to see the BACK color too.
    const raw: RawScryfallCard = {
      id: 's3',
      oracle_id: 'o3',
      name: 'Blightstep Pathway // Searstep Pathway',
      layout: 'modal_dfc',
      type_line: 'Land // Land',
      card_faces: [
        { name: 'Blightstep Pathway', type_line: 'Land', oracle_text: '{T}: Add {B}.' },
        { name: 'Searstep Pathway', type_line: 'Land', oracle_text: '{T}: Add {R}.' },
      ],
    };
    const card = toOracleCard(raw);
    expect(card?.name).toBe('Blightstep Pathway // Searstep Pathway');
    expect(card?.oracleText).toBe('{T}: Add {B}.'); // front, via faceFallback
    expect(card?.backFace).toEqual({
      name: 'Searstep Pathway',
      typeLine: 'Land',
      oracleText: '{T}: Add {R}.',
      manaCost: null,
      colors: [],
      power: null,
      toughness: null,
      loyalty: null,
      defense: null,
    });
  });

  it('omits backFace for a single-faced card', () => {
    const raw: RawScryfallCard = { id: 's4', oracle_id: 'o4', name: 'Forest', type_line: 'Basic Land — Forest' };
    expect(toOracleCard(raw)?.backFace).toBeUndefined();
  });

  it('drops non-game entries (tokens) and cards without an oracle id', () => {
    expect(toOracleCard({ id: 't', oracle_id: 'x', name: 'Goblin', layout: 'token' })).toBeNull();
    expect(toOracleCard({ id: 'n', name: 'Nameless' } as RawScryfallCard)).toBeNull();
  });
});
