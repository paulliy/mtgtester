import { describe, it, expect } from 'vitest';
import type { ValidationCode } from '@mtg/shared';
import { validateDeck } from './validate';
import { parseBannedList } from './banned';
import { makeOracleCard, makeResolvedDeck, fillerCreatures } from '../test-factory';

const NO_BANS = parseBannedList('');
const codes = (issues: { code: ValidationCode }[]): ValidationCode[] => issues.map((i) => i.code);

const greenCommander = makeOracleCard({
  name: 'Azusa, Lost but Seeking',
  typeLine: 'Legendary Creature — Human Monk',
  supertypes: ['Legendary'],
  types: ['Creature'],
  colorIdentity: ['G'],
  cmc: 3,
});

describe('validateDeck — a legal deck', () => {
  it('accepts a 100-card mono-green singleton deck', () => {
    const deck = makeResolvedDeck({
      commanders: [greenCommander],
      cards: fillerCreatures(99, ['G']),
    });
    const result = validateDeck(deck, NO_BANS);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('validateDeck — reports every problem, not just the first', () => {
  it('flags an off-count deck', () => {
    const deck = makeResolvedDeck({
      commanders: [greenCommander],
      cards: fillerCreatures(90, ['G']),
    });
    expect(codes(validateDeck(deck, NO_BANS).issues)).toContain('cardCount');
  });

  it('flags an illegal (non-legendary) commander', () => {
    const notACommander = makeOracleCard({
      name: 'Grizzly Bears',
      typeLine: 'Creature — Bear',
      types: ['Creature'],
      colorIdentity: ['G'],
      cmc: 2,
    });
    const deck = makeResolvedDeck({
      commanders: [notACommander],
      cards: fillerCreatures(99, ['G']),
    });
    expect(codes(validateDeck(deck, NO_BANS).issues)).toContain('commanderLegality');
  });

  it('flags a card outside the commander color identity', () => {
    const redCard = makeOracleCard({
      name: 'Lightning Bolt',
      typeLine: 'Instant',
      types: ['Instant'],
      colorIdentity: ['R'],
      cmc: 1,
    });
    const deck = makeResolvedDeck({
      commanders: [greenCommander],
      cards: [...fillerCreatures(98, ['G']), { quantity: 1, card: redCard }],
    });
    const identityIssues = validateDeck(deck, NO_BANS).issues.filter(
      (i) => i.code === 'colorIdentity',
    );
    expect(identityIssues[0]?.cardName).toBe('Lightning Bolt');
  });

  it('flags a non-basic played in multiples (singleton)', () => {
    const solRing = makeOracleCard({
      name: 'Sol Ring',
      typeLine: 'Artifact',
      types: ['Artifact'],
      cmc: 1,
    });
    const deck = makeResolvedDeck({
      commanders: [greenCommander],
      cards: [...fillerCreatures(97, ['G']), { quantity: 2, card: solRing }],
    });
    const singleton = validateDeck(deck, NO_BANS).issues.filter((i) => i.code === 'singleton');
    expect(singleton[0]?.cardName).toBe('Sol Ring');
  });

  it('allows unlimited copies of a basic land and text-override cards', () => {
    const petitioners = makeOracleCard({
      name: 'Persistent Petitioners',
      typeLine: 'Creature — Human Advisor',
      types: ['Creature'],
      colorIdentity: ['U'],
      oracleText: 'A deck can have any number of cards named Persistent Petitioners.',
      cmc: 1,
    });
    const blueCommander = makeOracleCard({
      name: 'Tetsuko Umezawa, Fugitive',
      typeLine: 'Legendary Creature — Human Rogue',
      supertypes: ['Legendary'],
      types: ['Creature'],
      colorIdentity: ['U'],
      cmc: 2,
    });
    const deck = makeResolvedDeck({
      commanders: [blueCommander],
      cards: [{ quantity: 99, card: petitioners }],
    });
    expect(validateDeck(deck, NO_BANS).issues.filter((i) => i.code === 'singleton')).toEqual([]);
  });

  it('flags a banned card by name', () => {
    const banned = parseBannedList('#### Channel\n');
    const channel = makeOracleCard({
      name: 'Channel',
      typeLine: 'Sorcery',
      types: ['Sorcery'],
      colorIdentity: ['G'],
      cmc: 1,
    });
    const deck = makeResolvedDeck({
      commanders: [greenCommander],
      cards: [...fillerCreatures(98, ['G']), { quantity: 1, card: channel }],
    });
    const bannedIssues = validateDeck(deck, banned).issues.filter((i) => i.code === 'banned');
    expect(bannedIssues[0]?.cardName).toBe('Channel');
  });
});

describe('validateDeck — commander pairings', () => {
  const partnerA = makeOracleCard({
    name: 'Bruse Tarl, Boorish Herder',
    typeLine: 'Legendary Creature — Human Nomad',
    supertypes: ['Legendary'],
    types: ['Creature'],
    colorIdentity: ['R', 'W'],
    oracleText: 'Partner (You can have two commanders if both have partner.)',
    keywords: ['Partner'],
    cmc: 4,
  });
  const partnerB = makeOracleCard({
    name: 'Tymna the Weaver',
    typeLine: 'Legendary Creature — Human Cleric',
    supertypes: ['Legendary'],
    types: ['Creature'],
    colorIdentity: ['W', 'B'],
    oracleText: 'Partner (You can have two commanders if both have partner.)',
    keywords: ['Partner'],
    cmc: 4,
  });

  it('accepts two commanders that both have Partner', () => {
    const deck = makeResolvedDeck({
      commanders: [partnerA, partnerB],
      cards: fillerCreatures(98, ['W']),
    });
    expect(validateDeck(deck, NO_BANS).issues.filter((i) => i.code === 'partnerPairing')).toEqual(
      [],
    );
  });

  it('rejects two commanders with no partner relationship', () => {
    const plainLegend = makeOracleCard({
      name: 'Some Legend',
      typeLine: 'Legendary Creature — Elf',
      supertypes: ['Legendary'],
      types: ['Creature'],
      colorIdentity: ['G'],
      cmc: 3,
    });
    const deck = makeResolvedDeck({
      commanders: [greenCommander, plainLegend],
      cards: fillerCreatures(98, ['G']),
    });
    expect(codes(validateDeck(deck, NO_BANS).issues)).toContain('partnerPairing');
  });
});

describe('validateDeck — companion condition', () => {
  const lurrus = makeOracleCard({
    name: 'Lurrus of the Dream-Den',
    typeLine: 'Legendary Creature — Cat Nightmare',
    supertypes: ['Legendary'],
    types: ['Creature'],
    colorIdentity: ['W', 'B'],
    oracleText:
      'Companion — Each permanent card in your starting deck has mana value 2 or less.\nDuring your turn, you may cast one permanent spell from your graveyard.',
    cmc: 3,
  });
  const whiteCommander = makeOracleCard({
    name: 'Heliod, Sun-Crowned',
    typeLine: 'Legendary Enchantment Creature — God',
    supertypes: ['Legendary'],
    types: ['Enchantment', 'Creature'],
    colorIdentity: ['W'],
    cmc: 3,
  });

  it('flags a companion whose condition the deck violates', () => {
    const bigPermanent = makeOracleCard({
      name: 'Serra Angel',
      typeLine: 'Creature — Angel',
      types: ['Creature'],
      colorIdentity: ['W'],
      cmc: 5,
    });
    const deck = makeResolvedDeck({
      commanders: [whiteCommander],
      companion: lurrus,
      cards: [
        ...fillerCreatures(98, ['W']).map((e) => ({
          quantity: 1,
          card: makeOracleCard({ ...e.card, cmc: 1 }),
        })),
        { quantity: 1, card: bigPermanent },
      ],
    });
    // 98 low-cost fillers + 1 oversized permanent + commander = 100, + companion = 101.
    const companionIssues = validateDeck(deck, NO_BANS).issues.filter(
      (i) => i.code === 'companion',
    );
    expect(companionIssues.length).toBeGreaterThan(0);
    expect(companionIssues[0]?.message).toMatch(/Lurrus/);
  });
});
