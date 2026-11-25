/**
 * Per-line playback boards share every part equal to the previous board (`shareUnchanged`), so
 * a retained board costs about what changed. Sharing must never change what a board says.
 */

import { describe, expect, it } from 'vitest';
import { Engine, RandomDecisionProvider } from '../src';
import { shareUnchanged } from '../src/log/log';
import type { OracleCard, SpectatorState } from '@mtg/shared';

describe('shareUnchanged', () => {
  it('returns the previous value when the two are equal', () => {
    const prev = { a: 1, b: [{ id: 'x', n: 2 }], c: { d: 'e' } };
    const next = { a: 1, b: [{ id: 'x', n: 2 }], c: { d: 'e' } };
    expect(shareUnchanged(prev, next)).toBe(prev);
  });

  it('shares equal parts and keeps the changed ones', () => {
    const prev = {
      a: 1,
      list: [
        { id: 'x', n: 1 },
        { id: 'y', n: 2 },
      ],
      c: { d: 'e' },
    };
    const next = {
      a: 2,
      list: [
        { id: 'x', n: 1 },
        { id: 'y', n: 3 },
      ],
      c: { d: 'e' },
    };
    const shared = shareUnchanged(prev, next);
    expect(shared).toBe(next);
    expect(shared.c).toBe(prev.c);
    expect(shared.list).not.toBe(prev.list);
    expect(shared.list[0]).toBe(prev.list[0]);
    expect(shared.list[1]).toEqual({ id: 'y', n: 3 });
    expect(JSON.stringify(shared)).toBe(
      JSON.stringify({
        a: 2,
        list: [
          { id: 'x', n: 1 },
          { id: 'y', n: 3 },
        ],
        c: { d: 'e' },
      }),
    );
  });

  it('matches array elements by id when one leaves', () => {
    const prev = [{ id: 'x' }, { id: 'y', t: [1] }, { id: 'z', t: [2] }];
    const next = [
      { id: 'y', t: [1] },
      { id: 'z', t: [2] },
    ];
    const shared = shareUnchanged(prev, next);
    expect(shared).toBe(next);
    expect(shared[0]).toBe(prev[1]);
    expect(shared[1]).toBe(prev[2]);
  });

  it('keeps key order, so the board serializes exactly as built', () => {
    const prev = { a: 1, b: 2 };
    const next = { b: 2, a: 1 };
    const shared = shareUnchanged(prev, next);
    expect(shared).toBe(next);
    expect(JSON.stringify(shared)).toBe('{"b":2,"a":1}');
  });

  it('treats a missing key and an extra key as a change', () => {
    const withUndefined = { a: 1, b: undefined };
    expect(shareUnchanged({ a: 1 }, withUndefined)).toBe(withUndefined);
    const next = { a: 1, b: 2 };
    expect(shareUnchanged({ a: 1 }, next)).toBe(next);
    const fewer = { a: 1 };
    expect(shareUnchanged({ a: 1, b: 2 }, fewer)).toBe(fewer);
  });

  it('never shares between an array and an object', () => {
    const next = { 0: 'a' };
    expect(shareUnchanged(['a'], next)).toBe(next);
    const list = ['a'];
    expect(shareUnchanged({ 0: 'a' }, list)).toBe(list);
  });
});

function card(n: number, overrides: Partial<OracleCard> = {}): OracleCard {
  return {
    oracleId: `forest-${n}`,
    scryfallId: `scry-forest-${n}`,
    name: 'Forest',
    manaCost: null,
    cmc: 0,
    colors: [],
    colorIdentity: ['G'],
    typeLine: 'Basic Land — Forest',
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: ['Forest'],
    oracleText: '',
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: true,
    ...overrides,
  };
}

describe('per-line playback boards', () => {
  it('say exactly what a freshly built board says, and share what did not change', () => {
    const engine = new Engine({
      gameId: 'g-share',
      seed: 'share-test',
      turnCap: 12,
      players: [1, 2, 3, 4].map((n) => ({
        id: `P${n}`,
        deckId: `deck-${n}`,
        commanders: [
          card(0, {
            oracleId: `general-P${n}`,
            scryfallId: `scry-general-P${n}`,
            name: `Test General P${n}`,
            manaCost: '{G}',
            cmc: 1,
            colors: ['G'],
            typeLine: 'Legendary Creature — Elf',
            supertypes: ['Legendary'],
            types: ['Creature'],
            subtypes: ['Elf'],
            power: '2',
            toughness: '2',
            isBasicLand: false,
          }),
        ],
        cards: Array.from({ length: 20 }, (_, i) => card(i)),
      })),
    });
    const providers = new Map(
      [1, 2, 3, 4].map((n) => [`P${n}`, new RandomDecisionProvider(`share-P${n}`)]),
    );
    const boards: SpectatorState[] = [];
    const atDrain: string[] = [];
    const drain = (): void => {
      for (const board of engine.drainSpectatorSnapshots().values()) {
        boards.push(board);
        atDrain.push(JSON.stringify(board));
      }
    };
    for (;;) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind === 'continue') continue;
      engine.submit(providers.get(step.request.decidingPlayer)!.decide(step.request));
      drain();
    }
    drain();
    expect(boards.length).toBeGreaterThan(50);
    // A shared part is never written after it is recorded: every board still says what it said.
    expect(boards.map((board) => JSON.stringify(board))).toEqual(atDrain);
    // Consecutive boards share the permanents that did not change.
    expect(
      boards
        .slice(1)
        .some((board, i) =>
          board.battlefield.some((perm) => boards[i]!.battlefield.includes(perm)),
        ),
    ).toBe(true);
    // Sharing real boards, freshly copied, changes nothing they say.
    for (let i = 1; i < boards.length; i++) {
      const next = structuredClone(boards[i]!);
      expect(JSON.stringify(shareUnchanged(structuredClone(boards[i - 1]!), next))).toBe(
        atDrain[i],
      );
    }
  });
});
