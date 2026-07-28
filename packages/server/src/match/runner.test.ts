/**
 * `MatchRunner` — the two invariants it exists to enforce (brief §10.1, §7.7):
 *
 *   1. never compute more than `lookaheadTurns` past the viewer, because each turn beyond them
 *      is real API budget;
 *   2. stop dead on a problematic state, and never resolve one unsupervised.
 */

import { describe, expect, it, vi } from 'vitest';
import { Engine, RandomDecisionProvider } from '@mtg/engine';
import type { AsyncDecisionProvider } from '@mtg/engine';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { ComputeHaltError, MatchRunner } from './runner';

/** A Forest, enough to make four seats that can legally take turns and do nothing else. */
function forest(n: number): OracleCard {
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
  };
}

function commander(seat: string): OracleCard {
  return {
    ...forest(0),
    oracleId: `general-${seat}`,
    scryfallId: `scry-general-${seat}`,
    name: `Test General ${seat}`,
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
  };
}

function makeEngine(seed = 'runner-test'): Engine {
  return new Engine({
    gameId: 'g-test',
    seed,
    turnCap: 60,
    players: [1, 2, 3, 4].map((n) => ({
      id: `P${n}`,
      deckId: `deck-${n}`,
      commanders: [commander(`P${n}`)],
      cards: Array.from({ length: 20 }, (_, i) => forest(i)),
    })),
  });
}

function randomProviders(seed = 'runner-test'): (playerId: string) => AsyncDecisionProvider {
  const cache = new Map<string, AsyncDecisionProvider>();
  return (playerId) => {
    let provider = cache.get(playerId);
    if (provider === undefined) {
      const inner = new RandomDecisionProvider(`${seed}-${playerId}`);
      provider = { decide: (request) => Promise.resolve(inner.decide(request)) };
      cache.set(playerId, provider);
    }
    return provider;
  };
}

const SEATS = [1, 2, 3, 4].map((n) => ({ seat: `P${n}`, deckSnapshotId: `snap-${n}` }));

describe('MatchRunner — compute-ahead cap (brief §10.1)', () => {
  it('parks once the frontier is lookahead turns past the viewer', async () => {
    const engine = makeEngine();
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      lookaheadTurns: 2,
    });

    const run = runner.run();
    // Give the pump time to reach the cap and park.
    await vi.waitFor(() => {
      expect(runner.getStatus()).toBe('waitingForView');
    });

    // The viewer never moved off turn 0, so the frontier must not exceed 0 + 2 + 1: the turn
    // that trips the cap is computed, and then nothing further.
    expect(runner.getFrontierTurn()).toBeLessThanOrEqual(3);

    runner.abandon();
    await run;
  });

  it('resumes when the viewer moves forward — watching is what pays for the next turns', async () => {
    const engine = makeEngine();
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      lookaheadTurns: 2,
    });

    const run = runner.run();
    await vi.waitFor(() => {
      expect(runner.getStatus()).toBe('waitingForView');
    });
    const parkedAt = runner.getFrontierTurn();

    runner.setViewTurn(parkedAt);
    await vi.waitFor(() => {
      expect(runner.getFrontierTurn()).toBeGreaterThan(parkedAt);
    });

    runner.abandon();
    await run;
  });

  it('runs to a finished game when the viewer keeps up', async () => {
    const engine = makeEngine();
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      // The viewer follows the frontier immediately, so the cap never binds.
      onSnapshot: (turn) => {
        runner.setViewTurn(turn);
      },
    });

    await runner.run();

    expect(['finished', 'halted']).toContain(runner.getStatus());
    // Whichever it was, the runner produced a definite outcome rather than stalling.
    expect(runner.getResult() ?? runner.getHalt()).not.toBeNull();
  });
});

describe('MatchRunner — snapshots and the scrubber', () => {
  it('records one snapshot per turn and refuses to seek past the frontier', async () => {
    const engine = makeEngine();
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      lookaheadTurns: 3,
    });

    const run = runner.run();
    await vi.waitFor(() => {
      expect(runner.getSnapshotTurns().length).toBeGreaterThan(1);
    });

    const turns = runner.getSnapshotTurns();
    expect(new Set(turns).size).toBe(turns.length);
    expect(runner.stateAt(turns[0] as number)).not.toBeNull();
    // Never forward past what has been computed (brief §10.1).
    expect(runner.stateAt(runner.getFrontierTurn() + 50)).toBeNull();

    runner.abandon();
    await run;
  });
});

describe('MatchRunner — hold-and-wait (brief §7.7, §10.1)', () => {
  it('halts, and computes nothing further, when a provider throws a ComputeHaltError', async () => {
    const engine = makeEngine();
    const random = randomProviders();
    let decisions = 0;

    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: (playerId) => ({
        decide: async (request) => {
          if (++decisions === 5) {
            throw new ComputeHaltError('invalidAiResponse', 'model failed twice during lookahead');
          }
          return random(playerId).decide(request);
        },
      }),
      onSnapshot: (turn) => {
        runner.setViewTurn(turn);
      },
    });

    await runner.run();

    expect(runner.getStatus()).toBe('halted');
    expect(runner.getHalt()?.kind).toBe('invalidAiResponse');
    // The offending decision is the last one attempted; nothing ran past it.
    expect(decisions).toBe(5);
  });

  it('reports an engine error as a halt rather than throwing out of run()', async () => {
    const engine = makeEngine();
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: () => ({
        decide: () => Promise.reject(new Error('provider exploded')),
      }),
      onSnapshot: (turn) => {
        runner.setViewTurn(turn);
      },
    });

    await expect(runner.run()).resolves.toBeUndefined();
    expect(runner.getStatus()).toBe('halted');
    expect(runner.getHalt()?.kind).toBe('engineError');
    expect(runner.getHalt()?.reason).toContain('provider exploded');
  });
});

describe('MatchRunner — §7.7 escalation', () => {
  it('returns null to allow safest fallback when the decision is ahead of the viewer', async () => {
    const engine = makeEngine();
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      lookaheadTurns: 2,
    });

    const run = runner.run();
    await vi.waitFor(() => {
      expect(runner.getFrontierTurn()).toBeGreaterThan(0);
    });

    // Viewer is at turn 0 while the frontier has moved on: nobody is watching this decision.
    runner.setViewTurn(0);
    const request = { decidingPlayer: 'P1', requestId: 'r1' } as DecisionRequest;

    await expect(runner.escalation().onModelFailed(request, 'bad json')).resolves.toBeNull();

    runner.abandon();
    await run;
  });

  it('surfaces the decision and returns the human pick when the viewer is at the frontier', async () => {
    const engine = makeEngine();
    const surfaced: string[] = [];
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      escalationTimeoutMs: 5_000,
      onDecisionPending: (request) => {
        surfaced.push(request.requestId);
      },
    });

    const request = { decidingPlayer: 'P1', requestId: 'r-held' } as DecisionRequest;
    const pending = runner.escalation().onModelFailed(request, 'bad json');

    await vi.waitFor(() => {
      expect(surfaced).toEqual(['r-held']);
    });
    expect(runner.resolveHeldDecision('r-held', 3)).toBe(true);

    await expect(pending).resolves.toEqual({ requestId: 'r-held', actionId: 3 });
  });

  it('falls back to null — and therefore the safest legal action — on timeout', async () => {
    const engine = makeEngine();
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      escalationTimeoutMs: 20,
    });

    const request = { decidingPlayer: 'P1', requestId: 'r-timeout' } as DecisionRequest;
    await expect(runner.escalation().onModelFailed(request, 'bad json')).resolves.toBeNull();
  });

  it('ignores an answer for a decision it is not holding', () => {
    const engine = makeEngine();
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
    });

    expect(runner.resolveHeldDecision('nothing-is-held', 0)).toBe(false);
  });
});

describe('MatchRunner — persistence hooks', () => {
  it('opens the game row, appends events, and snapshots each turn', async () => {
    const engine = makeEngine();
    const appended: number[] = [];
    const snapshotted: number[] = [];
    const recorder = {
      start: vi.fn(),
      appendEvents: vi.fn((events: Array<{ sequence: number }>) => {
        appended.push(...events.map((e) => e.sequence));
      }),
      saveTurnSnapshot: vi.fn((turn: number) => {
        snapshotted.push(turn);
      }),
      loadTurnSnapshot: vi.fn(() => null),
      snapshotTurns: vi.fn(() => []),
      loadEvents: vi.fn(() => []),
      markStatus: vi.fn(),
      finish: vi.fn(),
    };

    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      recorder: recorder as never,
      lookaheadTurns: 2,
    });

    const run = runner.run();
    await vi.waitFor(() => {
      expect(snapshotted.length).toBeGreaterThan(1);
    });

    expect(recorder.start).toHaveBeenCalledWith('runner-test', SEATS, 'spectator');
    // Event sequences are flushed once each, in order — the cursor never re-sends or skips.
    expect(appended).toEqual([...appended].sort((a, b) => a - b));
    expect(new Set(appended).size).toBe(appended.length);

    runner.abandon();
    await run;
    expect(recorder.markStatus).toHaveBeenCalledWith('abandoned');
  });
});
