/**
 * `MatchRunner` — the two invariants it exists to enforce (brief §10.1, §7.7):
 *
 *   1. never compute more than `lookaheadTurns` past the viewer, because each turn beyond them
 *      is real API budget;
 *   2. stop dead on a problematic state, and never resolve one unsupervised.
 */

import { describe, expect, it, vi } from 'vitest';
import { Engine, RandomDecisionProvider } from '@mtg/engine';
import type { AsyncDecisionProvider, DebugEntry } from '@mtg/engine';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { ComputeHaltError, MatchRunner, eliminatorFor } from './runner';

async function waitFor(
  fn: () => void | Promise<void>,
  options?: { timeout?: number } | number,
): Promise<void> {
  const timeoutMs = typeof options === 'number' ? options : (options?.timeout ?? 5000);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fn();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  await fn();
}

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

describe('MatchRunner — compute-ahead cap (brief §10.1)', { timeout: 60_000 }, () => {
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
    await waitFor(() => {
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
    await waitFor(() => {
      expect(runner.getStatus()).toBe('waitingForView');
    });
    const parkedAt = runner.getFrontierTurn();

    runner.setViewTurn(parkedAt);
    await waitFor(() => {
      expect(runner.getFrontierTurn()).toBeGreaterThan(parkedAt);
    });

    runner.abandon();
    await run;
  });

  it('does not park before the first decision of a prepared mid-game scenario', async () => {
    // Card Test Lab engines start at turn 1+: the initial snapshot is already past turn 0, so a
    // viewer anchored at turn 0 with no lookahead must not deadlock the pump (the lab stall).
    const engine = new Engine(
      {
        gameId: 'g-lab',
        seed: 'runner-lab',
        turnCap: 4,
        players: [1, 2, 3, 4].map((n) => ({
          id: `P${n}`,
          deckId: `deck-${n}`,
          commanders: [],
          cards: Array.from({ length: 10 }, (_, i) => forest(i)),
        })),
      },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          // A playable land keeps the first priority window a real choice rather than a forced
          // pass the engine auto-resolves without surfacing a decision.
          hand: [{ playerId: 'P1', cardNames: ['Forest'] }],
          battlefield: [],
        },
      },
    );
    const seen: DecisionRequest[] = [];
    const runner = new MatchRunner({
      engine,
      gameId: 'g-lab',
      seed: 'runner-lab',
      seats: SEATS,
      lookaheadTurns: 0,
      providerFor: () => ({
        decide: (request) => {
          seen.push(request);
          const action =
            request.legalActions.find((candidate) => candidate.type === 'pass') ??
            request.legalActions[0]!;
          return Promise.resolve({ requestId: request.requestId, actionId: action.id });
        },
      }),
    });

    const run = runner.run();
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
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

describe('MatchRunner — the thread stays responsive', () => {
  it('yields to the event loop on time as well as on step count', async () => {
    // Every decision costs 20 ms of synchronous work, as a slow late-game bot step does. Counting
    // steps alone held the thread for 200 of them (four seconds here, minutes at a table); a
    // timer queued at the start must run within the first few decisions instead.
    const inner = randomProviders();
    let decisions = 0;
    const slow = (playerId: string): AsyncDecisionProvider => ({
      decide: (request) => {
        decisions += 1;
        const until = Date.now() + 20;
        while (Date.now() < until) {
          // busy: the work a slow step does without awaiting anything
        }
        return inner(playerId).decide(request);
      },
    });
    const engine = makeEngine();
    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: slow,
      onSnapshot: (turn) => {
        runner.setViewTurn(turn);
      },
    });
    let decisionsWhenTimerRan: number | null = null;
    setTimeout(() => {
      decisionsWhenTimerRan = decisions;
      runner.abandon();
    }, 0);
    await runner.run();
    expect(decisionsWhenTimerRan).not.toBeNull();
    expect(decisionsWhenTimerRan!).toBeLessThanOrEqual(5);
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
    await waitFor(() => {
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
    await waitFor(() => {
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

    await waitFor(() => {
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
    await waitFor(() => {
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

describe('eliminatorFor', () => {
  const lost = { id: 'P1', hasLost: true, lossReason: 'lifeZeroOrLess' } as const;

  it('credits the last damaging seat for a genuine loss', () => {
    expect(eliminatorFor(lost, 'P3')).toBe('P3');
    expect(eliminatorFor({ ...lost, lossReason: 'commanderDamage' }, 'P2')).toBe('P2');
  });

  it('credits nobody for a survivor, a decked player, or self-inflicted damage', () => {
    expect(eliminatorFor({ id: 'P1', hasLost: false, lossReason: null }, 'P2')).toBeNull();
    expect(eliminatorFor({ ...lost, lossReason: 'emptyLibraryDraw' }, 'P2')).toBeNull();
    expect(eliminatorFor(lost, 'P1')).toBeNull();
    expect(eliminatorFor(lost, null)).toBeNull();
  });

  it('records eliminators only for genuine losses in a full game', async () => {
    const finish = vi.fn();
    const recorder = {
      start: vi.fn(),
      appendEvents: vi.fn(),
      saveTurnSnapshot: vi.fn(),
      loadTurnSnapshot: vi.fn(() => null),
      snapshotTurns: vi.fn(() => []),
      loadEvents: vi.fn(() => []),
      markStatus: vi.fn(),
      finish,
    };
    const runner = new MatchRunner({
      engine: makeEngine(),
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      recorder: recorder as never,
      onSnapshot: (turn) => {
        runner.setViewTurn(turn);
      },
    });

    await runner.run();

    expect(finish).toHaveBeenCalledTimes(1);
    const seats = finish.mock.calls[0]?.[2] as Array<{
      seat: string;
      lossReason: string | null;
      eliminatedBySeat: string | null;
    }>;
    expect(seats).toHaveLength(SEATS.length);
    for (const seat of seats) {
      if (seat.eliminatedBySeat === null) continue;
      expect(seat.lossReason).not.toBeNull();
      expect(seat.lossReason).not.toBe('emptyLibraryDraw');
      expect(seat.eliminatedBySeat).not.toBe(seat.seat);
    }
  });

  it("records each loser's own elimination turn, not the game's final turn", async () => {
    const finish = vi.fn();
    const appendEvents = vi.fn();
    const recorder = {
      start: vi.fn(),
      appendEvents,
      saveTurnSnapshot: vi.fn(),
      loadTurnSnapshot: vi.fn(() => null),
      snapshotTurns: vi.fn(() => []),
      loadEvents: vi.fn(() => []),
      markStatus: vi.fn(),
      finish,
    };
    const runner = new MatchRunner({
      engine: makeEngine(),
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      recorder: recorder as never,
      onSnapshot: (turn) => {
        runner.setViewTurn(turn);
      },
    });

    await runner.run();

    const eliminations = new Map<string, number>();
    for (const call of appendEvents.mock.calls) {
      for (const event of call[0] as Array<{
        type: string;
        turn: number;
        payload: { player?: string };
      }>) {
        if (event.type === 'playerEliminated' && event.payload.player !== undefined) {
          eliminations.set(event.payload.player, event.turn);
        }
      }
    }
    const seats = finish.mock.calls[0]?.[2] as Array<{
      seat: string;
      eliminatedOnTurn: number | null;
    }>;
    const losers = seats.filter((seat) => seat.eliminatedOnTurn !== null);
    // Twenty-card libraries deck each seat out on its own turn, so the losers fall on
    // different turns — exactly the case that recording the final turn for everyone hid.
    expect(losers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(losers.map((seat) => seat.eliminatedOnTurn)).size).toBeGreaterThan(1);
    for (const seat of losers) {
      expect(seat.eliminatedOnTurn).toBe(eliminations.get(seat.seat));
    }
  });
});

describe('MatchRunner — decision anchor sequences (ADR 0022)', () => {
  it('anchors each decision to the first event that decision produced', async () => {
    const engine = makeEngine();
    const anchors: number[] = [];
    const sampleSize = 40;
    /** `[claimed anchor, sequence the decision's events actually started at]` pairs. */
    const firstOfEachRun: Array<[number, number]> = [];
    let previous: number | null = null;

    const runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      providerFor: randomProviders(),
      // High enough that the compute-ahead cap never parks the pump — this test is about the
      // anchor, and a parked runner simply stops producing decisions to check.
      lookaheadTurns: 60,
      // Assertions are collected, never thrown from inside the callback: the runner catches
      // everything its pump raises and turns it into a halt, which would swallow the failure
      // and surface as an unexplained timeout instead.
      onDecision: (_request, _response, anchorSequence) => {
        // Consecutive anchors partition the event stream: everything in [previous, current) is
        // what the *previous* decision produced, so that run must begin exactly at `previous`.
        // An off-by-one here would hang every note on the wrong log line.
        if (previous !== null) {
          const produced = engine
            .eventsSince(previous)
            .filter((event) => event.sequence < anchorSequence);
          if (produced.length > 0) firstOfEachRun.push([previous, produced[0]?.sequence ?? -1]);
        }
        previous = anchorSequence;
        anchors.push(anchorSequence);
        // Resolved providers can keep the microtask queue busy until the whole game ends,
        // starving a waitFor timer. This contract needs a bounded sequence of decisions.
        if (anchors.length === sampleSize) runner.abandon();
      },
    });

    await runner.run();

    expect(anchors).toHaveLength(sampleSize);
    expect(firstOfEachRun.length).toBeGreaterThan(0);
    // The anchor must never point *past* the decision's own events — that would attach the
    // reasoning to a later play than the one it explains.
    expect(firstOfEachRun.filter(([anchor, first]) => first < anchor)).toEqual([]);
    // And it is exact for every decision after the opening one, where the cursor still sits at
    // its initial 0 while engine sequences start at 1. Annotations snap forward to the first
    // visible line, so that one-off lower bound resolves to the same place.
    expect(firstOfEachRun.slice(1).filter(([anchor, first]) => first !== anchor)).toEqual([]);
    // A repeated or decreasing anchor would silently stack every seat's reasoning onto one line.
    expect(anchors).toEqual([...anchors].sort((a, b) => a - b));
  });
});

/**
 * The pump used to await the provider before flushing what `advance()` had already produced.
 * `advance()` runs a decision's whole forced tail before surfacing the next request, so those
 * events stayed behind the cursor for as long as the provider took — indefinitely, for a human
 * seat. These two cover the ordering itself and the race the earlier hooks introduce; the
 * player-facing consequence is covered in `session.test.ts` on the prepared War Room scenario.
 */
describe('MatchRunner — the pump flushes before it awaits a provider', () => {
  /** Far enough in to be past a turn boundary, so the gated decision has a real tail behind it. */
  const GATED_DECISION = 6;

  it('leaves nothing behind the cursor at any provider invocation, and holds that flush while one is pending', async () => {
    const engine = makeEngine();
    /** Every event sequence handed to the recorder, in delivery order. */
    const appended: number[] = [];
    let recordedDebug = 0;
    /** Identity of every debug entry the live hook saw — a re-delivery would repeat a reference. */
    const deliveredDebug = new Set<object>();
    const anchors: number[] = [];
    /** How many events were still unflushed at each provider invocation. Must be all zeroes. */
    const behind: number[] = [];
    let invocations = 0;
    /** The gated provider's resolver, parked here so the test can let the pump go on. */
    const releases: Array<() => void> = [];
    let runner: MatchRunner | null = null;

    const recorder = {
      start: vi.fn(),
      appendEvents: vi.fn((events: Array<{ sequence: number }>) => {
        appended.push(...events.map((event) => event.sequence));
      }),
      appendDebug: vi.fn((entries: DebugEntry[]) => {
        recordedDebug += entries.length;
      }),
      saveTurnSnapshot: vi.fn(),
      loadTurnSnapshot: vi.fn(() => null),
      snapshotTurns: vi.fn(() => []),
      loadEvents: vi.fn(() => []),
      markStatus: vi.fn(),
      finish: vi.fn(),
    };

    const inner = randomProviders();
    runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      recorder: recorder as never,
      // High enough that the compute-ahead cap never parks the pump — this is about the flush.
      lookaheadTurns: 60,
      providerFor: (playerId) => ({
        decide: async (request) => {
          // `nextSequence()` is the cursor: anything at or past it has not been flushed. The
          // whole point of the fix is that this is empty every single time.
          behind.push(engine.eventsSince(runner!.nextSequence()).length);
          if (++invocations === GATED_DECISION) {
            await new Promise<void>((resolve) => {
              releases.push(resolve);
            });
          }
          return inner(playerId).decide(request);
        },
      }),
      onDecision: (_request, _response, anchorSequence) => {
        anchors.push(anchorSequence);
      },
      onDebug: (entries) => {
        for (const entry of entries) deliveredDebug.add(entry);
      },
    });

    const run = runner.run();
    // The gated provider never resolves on its own, so this is the runner parked mid-decision
    // exactly as it is parked on a human seat.
    await waitFor(() => {
      expect(releases).toHaveLength(1);
    });

    expect(invocations).toBe(GATED_DECISION);
    expect(behind).toHaveLength(GATED_DECISION);
    expect(behind.filter((count) => count > 0)).toEqual([]);
    // Nothing is waiting on the pending decision: every event the engine has produced is out.
    expect(appended).toHaveLength(engine.eventsSince(0).length);
    const pendingAnchors = anchors.length;

    releases[0]?.();
    await waitFor(() => {
      expect(anchors.length).toBeGreaterThan(pendingAnchors);
    });
    runner.abandon();
    await run;

    // Post-submit flushing is unchanged: each sequence still leaves once, in order.
    expect(appended).toEqual([...appended].sort((a, b) => a - b));
    expect(new Set(appended).size).toBe(appended.length);
    expect(behind.filter((count) => count > 0)).toEqual([]);
    // Anchors still partition the stream — a flush moved earlier must not repeat or reorder one.
    expect(anchors).toEqual([...anchors].sort((a, b) => a - b));
    expect(new Set(anchors).size).toBe(anchors.length);
    // Debug drains reach the recorder and the live hook once each, not twice.
    expect(deliveredDebug.size).toBe(recordedDebug);
  });

  it('abandons from a synchronous early hook without invoking or submitting that decision', async () => {
    const engine = makeEngine();
    const submit = vi.spyOn(engine, 'submit');
    const advance = engine.advance.bind(engine);
    let surfaced = 0;
    vi.spyOn(engine, 'advance').mockImplementation(() => {
      const step = advance();
      if (step.kind === 'decision') surfaced += 1;
      return step;
    });

    let prefetches = 0;
    let cancelled = 0;
    let invocations = 0;
    let runner: MatchRunner | null = null;

    const inner = randomProviders();
    runner = new MatchRunner({
      engine,
      gameId: 'g-test',
      seed: 'runner-test',
      seats: SEATS,
      lookaheadTurns: 60,
      providerFor: (playerId) => ({
        decide: (request) => {
          invocations += 1;
          return inner(playerId).decide(request);
        },
      }),
      // The strategist prefetch seam. It now runs during the pre-provider bookkeeping, so an
      // in-flight prefetch can exist before this decision's provider has been chosen.
      onTurnBoundary: () => {
        prefetches += 1;
      },
      onEvents: () => {
        // `MatchSession.abandon()` in miniature — cancel the coordinator, then stop the runner —
        // reached synchronously from inside the runner's own flush. Skipped for `run()`'s
        // opening flush, which happens before any turn boundary.
        if (prefetches === 0 || cancelled > 0) return;
        cancelled += 1;
        runner!.abandon();
      },
    });

    await runner.run();

    expect(prefetches).toBeGreaterThan(0);
    expect(cancelled).toBe(1);
    expect(runner.getStatus()).toBe('abandoned');
    // The decision surfaced by the `advance()` whose bookkeeping abandoned the run is left
    // untouched: no provider was asked for it, and nothing was submitted for it.
    expect(surfaced).toBe(invocations + 1);
    expect(submit).toHaveBeenCalledTimes(invocations);
  });
});
