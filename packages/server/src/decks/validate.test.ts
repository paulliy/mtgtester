import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { OracleCard, ValidationCode } from '@mtg/shared';
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

  const legend = (
    name: string,
    oracleText: string,
    extra: Partial<Parameters<typeof makeOracleCard>[0]> = {},
  ) =>
    makeOracleCard({
      name,
      typeLine: 'Legendary Creature — Human',
      supertypes: ['Legendary'],
      types: ['Creature'],
      subtypes: ['Human'],
      colorIdentity: ['W'],
      oracleText,
      cmc: 3,
      ...extra,
    });
  const pairIssues = (a: ReturnType<typeof makeOracleCard>, b: ReturnType<typeof makeOracleCard>) =>
    validateDeck(
      makeResolvedDeck({ commanders: [a, b], cards: fillerCreatures(98, ['W']) }),
      NO_BANS,
    ).issues.filter((i) => i.code === 'partnerPairing');

  const merry = legend(
    'Merry, Esquire of Rohan',
    'Partner with Pippin, Guard of the Citadel (When this creature enters, target player may put Pippin into their hand from their library, then shuffle.)\nMerry gets +1/+0 for each other legendary creature you control.',
    { keywords: ['Partner with', 'Partner'] },
  );
  const pippin = legend(
    'Pippin, Guard of the Citadel',
    'Partner with Merry, Esquire of Rohan (When this creature enters, target player may put Merry into their hand from their library, then shuffle.)\nVigilance, ward {1}',
    { keywords: ['Partner with', 'Partner'] },
  );

  it('accepts a matched Partner with pair', () => {
    expect(pairIssues(merry, pippin)).toEqual([]);
  });

  it('rejects a Partner with card beside a plain Partner card (CR 702.124f)', () => {
    expect(pairIssues(merry, partnerB)).toHaveLength(1);
  });

  it('rejects two Partner with cards that name other cards', () => {
    const other = legend('Ganax, Astral Hunter', 'Partner with Someone Else', {
      keywords: ['Partner with', 'Partner'],
    });
    expect(pairIssues(merry, other)).toHaveLength(1);
  });

  it('pairs Partner variants only with the same variant', () => {
    const a = legend('Splinter, Radical Rat', 'Partner—Character select', {
      keywords: ['Partner'],
    });
    const b = legend('Leonardo, Sewer Samurai', 'Partner—Character select', {
      keywords: ['Partner'],
    });
    const c = legend('Other Variant', 'Partner—Survivors', { keywords: ['Partner'] });
    expect(pairIssues(a, b)).toEqual([]);
    expect(pairIssues(a, c)).toHaveLength(1);
    expect(pairIssues(a, partnerB)).toHaveLength(1);
  });

  it('pairs Friends forever only with Friends forever', () => {
    const a = legend(
      'Friend A',
      'Friends forever (You can have two commanders if both have friends forever.)',
    );
    const b = legend('Friend B', 'Flying\nFriends forever');
    expect(pairIssues(a, b)).toEqual([]);
    expect(pairIssues(a, partnerB)).toHaveLength(1);
  });

  it("pairs Doctor's companion with an imported Time Lord Doctor (CR 702.124m)", () => {
    const companion = legend('Clara Oswald', "Doctor's companion");
    const doctor = (subtypes: string[]) =>
      legend('The Eleventh Doctor', 'Vigilance', {
        typeLine: 'Legendary Creature — Time Lord Doctor',
        subtypes,
      });
    // The importer's parseTypeLine splits "Time Lord" on whitespace.
    expect(pairIssues(companion, doctor(['Time', 'Lord', 'Doctor']))).toEqual([]);
    expect(pairIssues(companion, doctor(['Time Lord', 'Doctor']))).toEqual([]);
    expect(pairIssues(companion, doctor(['Human', 'Doctor']))).toHaveLength(1);
    expect(pairIssues(companion, doctor(['Time', 'Lord', 'Doctor', 'Human']))).toHaveLength(1);
  });

  const background = makeOracleCard({
    name: 'Raised by Giants',
    typeLine: 'Legendary Enchantment — Background',
    supertypes: ['Legendary'],
    types: ['Enchantment'],
    subtypes: ['Background'],
    colorIdentity: ['G'],
    oracleText:
      'Commander creatures you own have base power and toughness 10/10 and are Giants in addition to their other types.',
    cmc: 6,
  });
  const chooser = legend(
    'Wilson, Refined Grizzly',
    'Choose a Background (You can have a Background as a second commander.)\nTrample, ward {2}',
  );

  it('accepts a Choose a Background creature with a Background (CR 702.124k)', () => {
    expect(pairIssues(chooser, background)).toEqual([]);
    expect(pairIssues(background, chooser)).toEqual([]);
  });

  it('rejects a Background beside a creature that cannot choose one', () => {
    expect(pairIssues(partnerA, background)).toHaveLength(1);
  });

  it('rejects a non-legendary Background enchantment', () => {
    const plain = makeOracleCard({
      ...background,
      name: 'Fake Background',
      oracleId: 'Fake Background',
      scryfallId: 'Fake Background',
      supertypes: [],
      typeLine: 'Enchantment — Background',
    });
    expect(pairIssues(chooser, plain)).toHaveLength(1);
  });

  it('rejects the same partner named twice', () => {
    expect(pairIssues(partnerA, partnerA)).toHaveLength(1);
  });

  it('rejects three commanders', () => {
    const deck = makeResolvedDeck({
      commanders: [partnerA, partnerB, merry],
      cards: fillerCreatures(97, ['W']),
    });
    expect(codes(validateDeck(deck, NO_BANS).issues)).toContain('partnerPairing');
  });

  it('uses the union of both color identities and counts 98 + 2', () => {
    const deck = makeResolvedDeck({
      commanders: [partnerA, partnerB],
      cards: [
        ...fillerCreatures(97, ['W']),
        {
          quantity: 1,
          card: makeOracleCard({ name: 'Red Filler', types: ['Creature'], colorIdentity: ['R'] }),
        },
      ],
    });
    const issues = validateDeck(deck, NO_BANS).issues;
    expect(codes(issues)).not.toContain('colorIdentity');
    expect(codes(issues)).not.toContain('cardCount');
  });
});

describe('validateDeck — pinned pair cards', () => {
  const pins = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../engine/tests/fixtures/pairs-and-hand-look-oracle.json'),
      'utf8',
    ),
  ) as { cards: { card: OracleCard }[] };
  const real = (name: string): OracleCard => pins.cards.find((e) => e.card.name === name)!.card;
  const pairIssues = (a: OracleCard, b: OracleCard) =>
    validateDeck(
      makeResolvedDeck({ commanders: [a, b], cards: fillerCreatures(98, ['W']) }),
      NO_BANS,
    ).issues.filter((i) => i.code === 'partnerPairing');

  it('pairs two real plain partners and rejects the other kinds beside them', () => {
    expect(
      pairIssues(real('Rograkh, Son of Rohgahh'), real('Ishai, Ojutai Dragonspeaker')),
    ).toEqual([]);
    expect(pairIssues(real('Rograkh, Son of Rohgahh'), real('Alphinaud Leveilleur'))).toHaveLength(
      1,
    );
    expect(pairIssues(real('Rograkh, Son of Rohgahh'), real('Splinter, the Mentor'))).toHaveLength(
      1,
    );
    expect(
      pairIssues(real('Rograkh, Son of Rohgahh'), real('Jaheira, Friend of the Forest')),
    ).toHaveLength(1);
  });

  it('pairs a real Choose a Background creature with a Background', () => {
    const background = makeOracleCard({
      name: 'Raised by Giants',
      typeLine: 'Legendary Enchantment — Background',
      supertypes: ['Legendary'],
      types: ['Enchantment'],
      subtypes: ['Background'],
    });
    expect(pairIssues(real('Jaheira, Friend of the Forest'), background)).toEqual([]);
    expect(pairIssues(real('Ganax, Astral Hunter'), real('Wilson, Refined Grizzly'))).toHaveLength(
      1,
    );
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
