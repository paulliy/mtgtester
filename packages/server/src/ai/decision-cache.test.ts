import { describe, expect, it } from 'vitest';
import type { DecisionRequest, DecisionResponse, PlayerView } from '@mtg/shared';
import { DecisionCache, digestDecision } from './decision-cache';

function makeView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    seat: 'P1',
    life: 40,
    hand: [{ id: 'c1', name: "Predator's Strike" }],
    deck: [],
    graveyard: [],
    exile: [],
    commanders: [],
    availableMana: { G: 2 },
    manaSources: [],
    opponents: [],
    battlefield: [],
    stack: [],
    recentLog: [],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: 'req-1',
    gameId: 'g1',
    turn: 8,
    activePlayer: 'P2',
    decidingPlayer: 'P1',
    phase: 'beginning',
    step: 'upkeep',
    decisionType: 'priority',
    prompt: 'You have priority.',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass priority' },
      { id: 1, type: 'castSpell', description: "Cast Predator's Strike" },
    ],
    ...overrides,
  };
}

const ANSWER: DecisionResponse = { requestId: 'req-1', actionId: 1, note: 'from the model' };

describe('digestDecision', () => {
  it('ignores the turn number and request id', () => {
    const a = digestDecision(makeRequest(), makeView());
    const b = digestDecision(makeRequest({ turn: 12, requestId: 'req-99' }), makeView());

    expect(a).toBe(b);
  });

  it.each([
    ['life total', () => makeView({ life: 39 })],
    ['hand contents', () => makeView({ hand: [{ id: 'c2', name: 'Brute Strength' }] })],
    ['available mana', () => makeView({ availableMana: { G: 3 } })],
    [
      'mana sources',
      () =>
        makeView({
          manaSources: [{ name: 'Command Tower', symbols: ['W', 'U', 'B', 'R', 'G'], count: 1 }],
        }),
    ],
    [
      'the battlefield',
      () =>
        makeView({
          battlefield: [
            {
              id: 'p1',
              controller: 'P2',
              name: 'Tor Giant',
              power: 3,
              toughness: 3,
              tapped: false,
              status: [],
            },
          ],
        }),
    ],
    [
      'the stack',
      () => makeView({ stack: [{ id: 's1', controller: 'P2', description: 'Bolt', targets: [] }] }),
    ],
    [
      'opponent life',
      () =>
        makeView({
          opponents: [
            {
              seat: 'P2',
              life: 35,
              handSize: 4,
              librarySize: 80,
              graveyard: [],
              commanders: [],
              poisonCounters: 0,
              commanderDamageDealtToYou: 0,
            },
          ],
        }),
    ],
  ])('changes when %s changes', (_label, build) => {
    expect(digestDecision(makeRequest(), build())).not.toBe(
      digestDecision(makeRequest(), makeView()),
    );
  });

  it.each([
    ['phase', { phase: 'ending' as const, step: 'end' as const }],
    ['deciding player', { decidingPlayer: 'P4' }],
    ['decision type', { decisionType: 'declareAttackers' as const }],
    [
      'the legal-action menu',
      { legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }] },
    ],
  ])('changes when the %s changes', (_label, overrides) => {
    expect(digestDecision(makeRequest(overrides), makeView())).not.toBe(
      digestDecision(makeRequest(), makeView()),
    );
  });
});

describe('DecisionCache', () => {
  it('misses before anything is stored', () => {
    expect(new DecisionCache().get(makeRequest(), makeView())).toBeNull();
  });

  it('returns the stored answer re-stamped with the new request id', () => {
    const cache = new DecisionCache();
    cache.set(makeRequest(), makeView(), ANSWER);

    const hit = cache.get(makeRequest({ requestId: 'req-2', turn: 12 }), makeView());

    expect(hit).not.toBeNull();
    expect(hit?.requestId).toBe('req-2');
    expect(hit?.actionId).toBe(1);
    expect(hit?.note).toContain('Cache');
  });

  it('preserves targets, modes, x, and order', () => {
    const cache = new DecisionCache();
    const rich: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1,
      targets: [{ slot: 0, choice: 'obj-7' }],
      modes: [2],
      xValue: 3,
      order: [1, 0],
    };
    cache.set(makeRequest(), makeView(), rich);

    const hit = cache.get(makeRequest({ requestId: 'req-2' }), makeView());

    expect(hit?.targets).toEqual([{ slot: 0, choice: 'obj-7' }]);
    expect(hit?.modes).toEqual([2]);
    expect(hit?.xValue).toBe(3);
    expect(hit?.order).toEqual([1, 0]);
  });

  it('misses when the board state has moved on', () => {
    const cache = new DecisionCache();
    cache.set(makeRequest(), makeView(), ANSWER);

    expect(cache.get(makeRequest(), makeView({ life: 30 }))).toBeNull();
  });

  it('misses when the menu changed, so a stored actionId can never point at a new action', () => {
    const cache = new DecisionCache();
    cache.set(makeRequest(), makeView(), ANSWER);

    const differentMenu = makeRequest({
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 1, type: 'castSpell', description: 'Cast Giant Growth' },
      ],
    });

    expect(cache.get(differentMenu, makeView())).toBeNull();
  });

  it('evicts the least recently used entry past its bound', () => {
    const cache = new DecisionCache(2);
    const viewFor = (life: number): PlayerView => makeView({ life });

    cache.set(makeRequest(), viewFor(40), ANSWER);
    cache.set(makeRequest(), viewFor(39), ANSWER);
    // Touch the oldest so the next insert evicts the middle one instead.
    expect(cache.get(makeRequest(), viewFor(40))).not.toBeNull();
    cache.set(makeRequest(), viewFor(38), ANSWER);

    expect(cache.size).toBe(2);
    expect(cache.get(makeRequest(), viewFor(40))).not.toBeNull();
    expect(cache.get(makeRequest(), viewFor(38))).not.toBeNull();
    expect(cache.get(makeRequest(), viewFor(39))).toBeNull();
  });
});
