import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { buildStrategyProfile, STRATEGY_PROFILE_VERSION } from './strategy-profile';

function card(overrides: Partial<OracleCard> & Pick<OracleCard, 'oracleId' | 'name'>): OracleCard {
  return {
    scryfallId: overrides.oracleId,
    manaCost: '{2}{G}',
    cmc: 3,
    colors: ['G'],
    colorIdentity: ['G'],
    typeLine: 'Creature — Elf Druid',
    supertypes: [],
    types: ['Creature'],
    subtypes: ['Elf', 'Druid'],
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
  } as OracleCard;
}

describe('strategy profile', () => {
  it('is deterministic and carries inspectable role evidence', () => {
    const commander = card({
      oracleId: 'cmdr',
      name: 'Engine Commander',
      oracleText: 'Whenever you cast a creature spell, draw a card.',
      supertypes: ['Legendary'],
    });
    const ramp = card({ oracleId: 'ramp', name: 'Ramp Spell', oracleText: 'Add {G}{G}.' });
    const input = {
      commanders: [commander],
      cards: [{ card: ramp, quantity: 4 }],
      colorIdentity: ['G'] as const,
    };

    const first = buildStrategyProfile(input);
    const second = buildStrategyProfile(input);
    expect(first).toEqual(second);
    expect(first.profileVersion).toBe(STRATEGY_PROFILE_VERSION);
    expect(first.resources.ramp).toBe(4);
    expect(first.commanders[0]?.evidence.length).toBeGreaterThan(0);
  });

  it('keeps partner commanders as separate profile entries', () => {
    const first = card({ oracleId: 'a', name: 'Partner A', keywords: ['Partner'] });
    const second = card({ oracleId: 'b', name: 'Partner B', keywords: ['Partner'] });
    const profile = buildStrategyProfile({
      commanders: [first, second],
      cards: [],
      colorIdentity: ['G'],
    });
    expect(profile.commanders.map((item) => item.name)).toEqual(['Partner A', 'Partner B']);
  });
});
