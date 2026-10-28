/**
 * The streams of a `chacha20` game (ADR 0031 decision 4, multiplayer M2b task 4): fixed nonces, no
 * two consumers sharing one, the bot's `Rng` contract on a keyed source, and bot decks drawn from
 * their own stream under a random id.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { ChaCha20Rng, streamNonce } from '@mtg/engine';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import {
  GAME_STREAM,
  botRandomSource,
  botStreamId,
  chachaStream,
  consumerStreams,
  deckRng,
  deckStreamId,
  fallbackBotRandomSource,
  fallbackBotStreamId,
  newDeckAlias,
  newRngKey,
  resolveRngKey,
  seatIndex,
} from './rng-streams';
import { setupSeats, type SeatSetupDeps } from './setup';

const KEY = '9f3c71a05be2d48817c6aa0e5d7b2f64c1e8930ab4d57f26e08a1c93b7d4562f';
const OTHER_KEY = '2b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfe';

function draws(stream: { nextInt(n: number): number }, count = 8): number[] {
  return Array.from({ length: count }, () => stream.nextInt(1_000_000));
}

describe('stream ids', () => {
  it('are the fixed layout: game 0, bot 1+seat, fallback 5+seat, deck 9+seat', () => {
    expect(GAME_STREAM).toBe(0);
    expect([0, 1, 2, 3].map(botStreamId)).toEqual([1, 2, 3, 4]);
    expect([0, 1, 2, 3].map(fallbackBotStreamId)).toEqual([5, 6, 7, 8]);
    expect([0, 1, 2, 3].map(deckStreamId)).toEqual([9, 10, 11, 12]);
  });

  it('refuse a seat outside a four-seat table, which would collide with the next family', () => {
    for (const bad of [-1, 4, 1.5, Number.NaN]) {
      expect(() => botStreamId(bad)).toThrow(RangeError);
      expect(() => fallbackBotStreamId(bad)).toThrow(RangeError);
      expect(() => deckStreamId(bad)).toThrow(RangeError);
    }
  });

  it('read a seat name as its zero-based index', () => {
    expect(['P1', 'P2', 'P3', 'P4'].map(seatIndex)).toEqual([0, 1, 2, 3]);
    expect(() => seatIndex('P5')).toThrow(RangeError);
    expect(() => seatIndex('P0')).toThrow(RangeError);
  });
});

describe('no two consumers of a 4-seat game share a key and nonce', () => {
  it('has a distinct nonce for each of the 13 consumers under the one game key', () => {
    const consumers = consumerStreams(4);
    expect(consumers).toHaveLength(1 + 4 * 3);
    expect(new Set(consumers.map((c) => c.consumer)).size).toBe(consumers.length);
    const nonces = consumers.map((c) => JSON.stringify(streamNonce(c.id)));
    expect(new Set(nonces).size).toBe(consumers.length);
    expect(consumers.map((c) => c.id).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it('gives each consumer an output of its own, and the same key a different stream per nonce', () => {
    const outputs = consumerStreams(4).map((c) => draws(chachaStream(KEY, c.id)).join(','));
    expect(new Set(outputs).size).toBe(outputs.length);
  });

  it('reads the real consumers through those same ids', () => {
    // The helpers a session and setup call must be the streams the table above names.
    for (let seat = 0; seat < 4; seat++) {
      expect(draws(botRandomSource(KEY, seat))).toEqual(draws(chachaStream(KEY, 1 + seat)));
      expect(draws(fallbackBotRandomSource(KEY, seat))).toEqual(draws(chachaStream(KEY, 5 + seat)));
      expect(draws(deckRng(KEY, seat))).toEqual(draws(chachaStream(KEY, 9 + seat)));
    }
    // And the engine's own stream 0 is the game stream.
    expect(draws(new ChaCha20Rng(Array(32).fill(7), streamNonce(GAME_STREAM)))).toEqual(
      draws(chachaStream('07'.repeat(32), GAME_STREAM)),
    );
  });

  it('gives another key another stream for the same nonce', () => {
    expect(draws(chachaStream(KEY, 1))).not.toEqual(draws(chachaStream(OTHER_KEY, 1)));
  });
});

describe('a keyed bot source', () => {
  it("has the bot's Rng contract: a bound of zero or less returns 0", () => {
    const source = botRandomSource(KEY, 1);
    expect(source.nextInt(0)).toBe(0);
    expect(source.nextInt(-5)).toBe(0);
    // A zero bound draws nothing, so the next draw is the stream's first.
    expect(source.nextInt(1_000_000)).toBe(botRandomSource(KEY, 1).nextInt(1_000_000));
  });

  it('draws in range and is deterministic given the key and seat', () => {
    const source = botRandomSource(KEY, 2);
    for (let i = 0; i < 200; i++) {
      const value = source.nextInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
    expect(draws(botRandomSource(KEY, 2))).toEqual(draws(botRandomSource(KEY, 2)));
    expect(draws(botRandomSource(KEY, 2))).not.toEqual(draws(botRandomSource(KEY, 3)));
  });
});

describe('resolveRngKey', () => {
  it('is null for a legacy game and the key for a chacha20 one', () => {
    expect(resolveRngKey({})).toBeNull();
    expect(resolveRngKey({ rng: 'legacy' })).toBeNull();
    expect(resolveRngKey({ rng: 'chacha20', rngKey: KEY })).toBe(KEY);
  });

  it('refuses a missing or malformed key rather than downgrading to legacy', () => {
    expect(() => resolveRngKey({ rng: 'chacha20' })).toThrow(/needs an rngKey/);
    expect(() => resolveRngKey({ rng: 'chacha20', rngKey: 'abcd' })).toThrow(RangeError);
    expect(() => resolveRngKey({ rng: 'legacy', rngKey: KEY })).toThrow(/legacy/);
    expect(() => resolveRngKey({ rngKey: KEY })).toThrow(/legacy/);
  });

  it('mints a 32-byte key and a deck alias that differ every time', () => {
    expect(newRngKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(newRngKey()).not.toBe(newRngKey());
    expect(newDeckAlias()).toMatch(/^pool:[0-9a-f]{16}$/);
    expect(newDeckAlias()).not.toBe(newDeckAlias());
  });
});

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

function testPool() {
  const cards: OracleCard[] = [
    card({
      name: 'Test General',
      typeLine: 'Legendary Creature — Test Captain',
      supertypes: ['Legendary'],
      types: ['Creature'],
      colors: ['G'],
      colorIdentity: ['G'],
    }),
    card({
      name: 'Forest',
      typeLine: 'Basic Land — Forest',
      manaCost: null,
      cmc: 0,
      colorIdentity: ['G'],
      supertypes: ['Basic'],
      types: ['Land'],
      subtypes: ['Forest'],
      isBasicLand: true,
    }),
  ];
  for (let i = 0; i < 160; i++) cards.push(card({ name: `Test Bear ${i}` }));
  return buildSupportedPool(cards);
}

const names = (deck: { cards: OracleCard[] }): string[] => deck.cards.map((c) => c.name);

describe('generateCommanderDeck with an injected rng', () => {
  it('draws the deck from the stream, not the seed: same stream same deck, other stream another', () => {
    const a = generateCommanderDeck(testPool(), { rng: deckRng(KEY, 0) });
    const b = generateCommanderDeck(testPool(), { rng: deckRng(KEY, 0) });
    const c = generateCommanderDeck(testPool(), { rng: deckRng(KEY, 1) });
    expect(names(b)).toEqual(names(a));
    expect(names(c)).not.toEqual(names(a));
    expect(a.cards).toHaveLength(99);
  });

  it('keeps a seed that is given out of it when an rng is also given', () => {
    const a = generateCommanderDeck(testPool(), { seed: 'one', rng: deckRng(KEY, 0) });
    const b = generateCommanderDeck(testPool(), { seed: 'two', rng: deckRng(KEY, 0) });
    expect(names(b)).toEqual(names(a));
  });

  it('needs a seed or an rng', () => {
    expect(() => generateCommanderDeck(testPool(), {})).toThrow(/seed or an rng/);
  });

  it('leaves a seeded deck as it was', () => {
    const a = generateCommanderDeck(testPool(), { seed: 'legacy-seed' });
    const b = generateCommanderDeck(testPool(), { seed: 'legacy-seed' });
    expect(names(b)).toEqual(names(a));
  });
});

describe('setupSeats for pool seats', () => {
  const deps = { pool: testPool() } as unknown as SeatSetupDeps;
  const sources = [{ kind: 'pool' as const }, { kind: 'pool' as const }];

  async function seatsOf(gameSeed: string, rng?: { rng: 'chacha20'; rngKey: string }) {
    const result = await setupSeats(sources, deps, gameSeed, rng);
    if (!result.ok) throw new Error(result.problems.map((p) => p.message).join('; '));
    return result.seats;
  }

  it('keeps `pool:${seed}` and the seeded decks in a legacy game', async () => {
    const seats = await seatsOf('label');
    expect(seats.map((s) => s.config.deckId)).toEqual(['pool:label-seat1', 'pool:label-seat2']);
    expect(seats.map((s) => s.summary.deckId)).toEqual(['pool:label-seat1', 'pool:label-seat2']);
    const expected = generateCommanderDeck(deps.pool, { seed: 'label-seat1' });
    expect(names({ cards: seats[0]!.config.cards })).toEqual(names(expected));
  });

  it('draws each chacha20 seat from its own deck stream and names it by a random alias', async () => {
    const seats = await seatsOf('public-label', { rng: 'chacha20', rngKey: KEY });
    for (const [index, seat] of seats.entries()) {
      const expected = generateCommanderDeck(deps.pool, { rng: deckRng(KEY, index) });
      expect(names({ cards: seat.config.cards })).toEqual(names(expected));
      expect(seat.config.deckId).toMatch(/^pool:[0-9a-f]{16}$/);
      expect(seat.summary.deckId).toBe(seat.config.deckId);
      expect(seat.config.deckId).not.toContain('public-label');
    }
    expect(names({ cards: seats[0]!.config.cards })).not.toEqual(
      names({ cards: seats[1]!.config.cards }),
    );
  });

  it('does not let the public label or a pool source seed decide a chacha20 deck', async () => {
    const a = await seatsOf('label-a', { rng: 'chacha20', rngKey: KEY });
    const b = await seatsOf('label-b', { rng: 'chacha20', rngKey: KEY });
    const seeded = await setupSeats([{ kind: 'pool', seed: 'chosen' }], deps, 'label-c', {
      rng: 'chacha20',
      rngKey: KEY,
    });
    expect(names({ cards: b[0]!.config.cards })).toEqual(names({ cards: a[0]!.config.cards }));
    expect(seeded.ok && names({ cards: seeded.seats[0]!.config.cards })).toEqual(
      names({ cards: a[0]!.config.cards }),
    );
    // The id is an alias, not a function of anything given: it differs from run to run.
    expect(b[0]!.config.deckId).not.toBe(a[0]!.config.deckId);
  });

  it('refuses a chacha20 game with no key', async () => {
    await expect(setupSeats(sources, deps, 'label', { rng: 'chacha20' })).rejects.toThrow(
      /needs an rngKey/,
    );
  });
});
