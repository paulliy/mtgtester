/**
 * Deck generation from the engine-supported pool.
 *
 * Uses a synthetic pool rather than the Scryfall bulk file, so these run in CI (the bulk is
 * gitignored). The end-to-end proof that generated decks actually PLAY is `bun run pool --play`,
 * which needs the real pool; what these guard is legality-by-construction and determinism.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck, toParsedDeck } from './generate';

function card(partial: Partial<OracleCard> & { name: string }): OracleCard {
  const typeLine = partial.typeLine ?? 'Creature — Test';
  return {
    oracleId: `oracle-${partial.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    scryfallId: `scry-${partial.name}`,
    manaCost: '{1}',
    cmc: 1,
    colors: [],
    colorIdentity: [],
    typeLine,
    supertypes: [],
    types: [typeLine.split(' — ')[0] ?? 'Creature'],
    subtypes: [],
    oracleText: '',
    power: typeLine.includes('Creature') ? '2' : null,
    toughness: typeLine.includes('Creature') ? '2' : null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
    ...partial,
  };
}

const basic = (name: string, color: 'W' | 'U' | 'B' | 'R' | 'G'): OracleCard =>
  card({
    name,
    typeLine: `Basic Land — ${name}`,
    manaCost: null,
    cmc: 0,
    colorIdentity: [color],
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: [name],
    isBasicLand: true,
  });

/** A pool with one green commander and plenty of vanilla green/colorless bodies. */
function testPool(spellCount = 120) {
  const cards: OracleCard[] = [
    card({
      name: 'Test General',
      typeLine: 'Legendary Creature — Test Captain',
      supertypes: ['Legendary'],
      types: ['Creature'],
      colors: ['G'],
      colorIdentity: ['G'],
    }),
    basic('Forest', 'G'),
    basic('Island', 'U'),
  ];
  for (let i = 0; i < spellCount; i++) {
    cards.push(card({ name: `Test Bear ${i}`, colorIdentity: i % 3 === 0 ? ['G'] : [] }));
  }
  // An off-identity card that must never be chosen for a mono-green deck.
  cards.push(card({ name: 'Test Blue Thing', colors: ['U'], colorIdentity: ['U'] }));
  return buildSupportedPool(cards);
}

describe('buildSupportedPool', () => {
  it('keeps only modeled, commander-legal cards and tags them', () => {
    const pool = buildSupportedPool([
      card({ name: 'Vanilla' }),
      card({ name: 'Banned Thing', commanderLegality: 'banned' }),
      card({ name: 'Unmodeled Thing', oracleText: 'Sacrifice a goat: Win the game.' }),
      basic('Forest', 'G'),
    ]);

    const names = pool.cards.map((c) => c.card.name).sort();
    expect(names).toEqual(['Forest', 'Vanilla']);
    // The banned card is not even counted in the denominator.
    expect(pool.considered).toBe(3);
    expect(pool.cards.find((c) => c.card.name === 'Forest')).toMatchObject({
      isLand: true,
      isBasicLand: true,
      unlimited: true,
      identity: 'G',
    });
  });
});

describe('generateCommanderDeck', () => {
  it('builds exactly 100 cards including the commander (CR 903.5a)', () => {
    const deck = generateCommanderDeck(testPool(), { seed: 'a' });
    expect(deck.cards).toHaveLength(99);
  });

  it('is singleton outside basic lands (CR 903.5b)', () => {
    const deck = generateCommanderDeck(testPool(), { seed: 'a' });
    const counts = new Map<string, number>();
    for (const c of deck.cards) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);

    for (const [name, count] of counts) {
      const isBasic = deck.cards.find((c) => c.name === name)?.isBasicLand === true;
      if (!isBasic) expect(count, `${name} appears ${count} times`).toBe(1);
    }
  });

  it('never includes a card outside the commander color identity (CR 903.4)', () => {
    const deck = generateCommanderDeck(testPool(), { seed: 'a' });
    const identity = deck.commander.colorIdentity;
    for (const c of deck.cards) {
      for (const color of c.colorIdentity) {
        expect(identity, `${c.name} is outside {${identity.join('')}}`).toContain(color);
      }
    }
    expect(deck.cards.some((c) => c.name === 'Test Blue Thing')).toBe(false);
  });

  it('never includes the commander in the 99', () => {
    const deck = generateCommanderDeck(testPool(), { seed: 'a' });
    expect(deck.cards.some((c) => c.oracleId === deck.commander.oracleId)).toBe(false);
  });

  it('is deterministic — same seed, same decklist', () => {
    const a = generateCommanderDeck(testPool(), { seed: 'same' });
    const b = generateCommanderDeck(testPool(), { seed: 'same' });
    expect(b.commander.name).toBe(a.commander.name);
    expect(b.cards.map((c) => c.name)).toEqual(a.cards.map((c) => c.name));
  });

  it('produces a different decklist for a different seed', () => {
    const a = generateCommanderDeck(testPool(), { seed: 'one' });
    const b = generateCommanderDeck(testPool(), { seed: 'two' });
    expect(b.cards.map((c) => c.name)).not.toEqual(a.cards.map((c) => c.name));
  });

  it('honors an explicitly requested commander', () => {
    const deck = generateCommanderDeck(testPool(), {
      seed: 'a',
      commanderName: 'Test General',
    });
    expect(deck.commander.name).toBe('Test General');
  });

  it('throws rather than emitting a short or illegal deck', () => {
    // Far too few nonland cards to fill the 99 — failing here beats failing inside the engine.
    expect(() => generateCommanderDeck(testPool(10), { seed: 'a' })).toThrow(/need \d+/);
    expect(() =>
      generateCommanderDeck(testPool(), { seed: 'a', commanderName: 'No Such Card' }),
    ).toThrow(/not a modeled legendary creature/);
  });

  it('renders to a ParsedDeck that totals 100 cards', () => {
    const deck = generateCommanderDeck(testPool(), { seed: 'a' });
    const parsed = toParsedDeck(deck, 'test');
    const total =
      parsed.commanderNames.length + parsed.cards.reduce((sum, e) => sum + e.quantity, 0);
    expect(total).toBe(100);
  });
});
