import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '@mtg/engine';
import type { DecisionRequest, PlayerView } from '@mtg/shared';
import type { AiClient } from './client';

type AiCallResult = Awaited<ReturnType<AiClient['requestDecision']>>;
import { DEFAULT_AI_CONFIG } from './config';
import {
  readTacticianRequest,
  StrategyCoordinator,
  TACTICIAN_REQUEST_REASON_LIMIT,
} from './strategy-coordinator';
import { assembleStrategistPrompt } from './strategy-context';

const view: PlayerView = {
  seat: 'P1',
  life: 40,
  hand: [],
  deck: [],
  graveyard: [],
  exile: [],
  commanders: [],
  availableMana: {},
  manaSources: [],
  opponents: [],
  battlefield: [],
  stack: [],
  recentLog: [],
};

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: 'r1',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose.',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass priority' },
      { id: 1, type: 'playLand', description: 'Play Forest' },
    ],
    ...overrides,
  };
}

function strategist(): AiClient {
  return {
    activeModel: 'deepseek/deepseek-v4-flash',
    requestDecision: vi.fn().mockResolvedValue({
      response: {
        requestId: 'strategy',
        actionId: 0,
        turnStrategy: {
          intent: 'Develop mana, then hold interaction.',
          manaPlan: 'Play Forest before casting.',
          plannedActions: [
            { type: 'playLand', name: 'Forest', phase: 'precombatMain', step: null },
          ],
        },
      },
      meta: {
        model: 'deepseek/deepseek-v4-flash',
        promptTokens: 100,
        responseTokens: 30,
        latencyMs: 10,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    }),
  };
}

describe('StrategyCoordinator', () => {
  it('is off the critical path: prepare() returns before the strategist call resolves', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(client, queue, engine, DEFAULT_AI_CONFIG);
    const req = request();

    coordinator.prepare(req);
    // Nothing has landed yet — this is exactly what lets a tactical call proceed unblocked.
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
    expect(coordinator.tryExecutePlan(req)).toBeNull();
  });

  it('calls the strategist once per turn and executes an exact legal planned action once settled', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(client, queue, engine, DEFAULT_AI_CONFIG);
    const req = request();

    coordinator.prepare(req);
    await coordinator.settled();
    coordinator.prepare({ ...req, requestId: 'r2' });
    await coordinator.settled();

    expect(client.requestDecision).toHaveBeenCalledTimes(1);
    expect(engine.view).toHaveBeenCalledWith('P1');
    expect(coordinator.guidanceFor('P1').strategy?.intent).toContain('Develop mana');
    expect(coordinator.tryExecutePlan(req)?.actionId).toBe(1);
  });

  it('never plans the human seat own turn', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(
      client,
      queue,
      engine,
      DEFAULT_AI_CONFIG,
      undefined,
      new Set(['P1']),
    );
    const req = request();

    coordinator.prepare(req);
    await coordinator.settled();

    expect(client.requestDecision).not.toHaveBeenCalled();
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
  });

  it('never plans the turn of any seat in a set of human seats', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(
      client,
      queue,
      engine,
      DEFAULT_AI_CONFIG,
      undefined,
      new Set(['P1', 'P3']),
    );

    coordinator.prepare(request({ activePlayer: 'P1', requestId: 'a' }));
    coordinator.prepare(request({ activePlayer: 'P3', requestId: 'b' }));
    await coordinator.settled();
    expect(client.requestDecision).not.toHaveBeenCalled();

    coordinator.prepare(request({ activePlayer: 'P2', requestId: 'c' }));
    await coordinator.settled();
    expect(client.requestDecision).toHaveBeenCalledTimes(1);
  });

  it('prefetches at a turn boundary ahead of the first real decision', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(client, queue, engine, DEFAULT_AI_CONFIG);

    coordinator.prefetch('g1', 1, 'P1');
    await coordinator.settled();
    // The real first decision of the turn arrives after the prefetch already landed the plan;
    // it must not trigger a second strategist call.
    coordinator.prepare(request());

    expect(client.requestDecision).toHaveBeenCalledTimes(1);
    expect(coordinator.guidanceFor('P1').strategy?.intent).toContain('Develop mana');
  });

  it('invalidates the active plan when another seat takes a non-pass action, and re-plans once', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );
    const req = request();
    coordinator.prepare(req);
    await coordinator.settled();

    const opponent = request({
      requestId: 'opp',
      decidingPlayer: 'P2',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 2, type: 'castSpell', description: 'Cast Giant Growth' },
      ],
    });
    coordinator.recordDecision(opponent, { requestId: opponent.requestId, actionId: 2 }, 'primary');

    // The intervention nulls the strategy immediately...
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
    expect(coordinator.tryExecutePlan({ ...req, requestId: 'after' })).toBeNull();
    // ...but off the critical path a re-plan is affordable, and it has already been started.
    await coordinator.settled();
    expect(client.requestDecision).toHaveBeenCalledTimes(2);
    expect(coordinator.guidanceFor('P1').strategy?.intent).toContain('Develop mana');

    // A second intervention this same turn does not trigger a third call.
    const opponent2 = request({
      requestId: 'opp2',
      decidingPlayer: 'P2',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 2, type: 'castSpell', description: 'Cast Lightning Bolt' },
      ],
    });
    coordinator.recordDecision(opponent2, { requestId: 'opp2', actionId: 2 }, 'primary');
    await coordinator.settled();
    expect(client.requestDecision).toHaveBeenCalledTimes(2);
  });

  it('rejects late-resolving strategist calls after opponent intervention', async () => {
    let resolveFirst!: (val: AiCallResult) => void;
    const promise1 = new Promise<AiCallResult>((resolve) => {
      resolveFirst = resolve;
    });

    let callCount = 0;
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return promise1;
        return Promise.resolve({
          response: {
            requestId: 'strategy-replan',
            actionId: 0,
            turnStrategy: {
              intent: 'Replanned strategy intent',
              plannedActions: [],
            },
          },
          meta: {
            model: 'test',
            promptTokens: 10,
            responseTokens: 10,
            latencyMs: 5,
            wasRetry: false,
            wasFallback: false,
            rawResponse: '{}',
          },
        });
      }),
    };
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;

    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    const req = request();
    coordinator.prepare(req);

    // Opponent intervenes while strategist call 1 is still in flight (triggers re-plan call 2)
    const opponent = request({
      requestId: 'opp',
      decidingPlayer: 'P2',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 2, type: 'castSpell', description: 'Cast Giant Growth' },
      ],
    });
    coordinator.recordDecision(opponent, { requestId: opponent.requestId, actionId: 2 }, 'primary');

    // Re-plan call 2 settles with 'Replanned strategy intent'
    await coordinator.settled();
    expect(coordinator.guidanceFor('P1').strategy?.intent).toBe('Replanned strategy intent');

    // Now resolve the first (stale) strategist call
    resolveFirst({
      response: {
        requestId: 'strategy-stale',
        actionId: 0,
        turnStrategy: {
          intent: 'Stale strategy intent',
          plannedActions: [{ type: 'playLand', name: 'Forest', phase: 'precombatMain' }],
        },
      },
      meta: {
        model: 'test',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });

    await coordinator.settled();

    // The stale response must NOT overwrite the replanned strategy
    expect(coordinator.guidanceFor('P1').strategy?.intent).toBe('Replanned strategy intent');
  });

  it('prevents out-of-order re-plans from overwriting fresh strategies', async () => {
    let resolveFirst!: (val: AiCallResult) => void;
    let resolveSecond!: (val: AiCallResult) => void;

    const promise1 = new Promise<AiCallResult>((resolve) => {
      resolveFirst = resolve;
    });
    const promise2 = new Promise<AiCallResult>((resolve) => {
      resolveSecond = resolve;
    });

    let callCount = 0;
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? promise1 : promise2;
      }),
    };
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;

    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    // Call 1 started
    const req = request();
    coordinator.prepare(req);

    // Opponent intervention triggers re-plan (Call 2 started)
    const opponent = request({
      requestId: 'opp',
      decidingPlayer: 'P2',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 2, type: 'castSpell', description: 'Cast Instant' },
      ],
    });
    coordinator.recordDecision(opponent, { requestId: opponent.requestId, actionId: 2 }, 'primary');

    // Call 2 resolves FIRST (fresh)
    resolveSecond({
      response: {
        requestId: 'strategy-fresh',
        actionId: 0,
        turnStrategy: {
          intent: 'Fresh strategy intent',
          plannedActions: [],
        },
      },
      meta: {
        model: 'test',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });

    await coordinator.settled();
    expect(coordinator.guidanceFor('P1').strategy?.intent).toBe('Fresh strategy intent');

    // Call 1 resolves SECOND (stale)
    resolveFirst({
      response: {
        requestId: 'strategy-stale',
        actionId: 0,
        turnStrategy: {
          intent: 'Stale strategy intent',
          plannedActions: [],
        },
      },
      meta: {
        model: 'test',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });

    // The fresh strategy intent should NOT be overwritten by stale intent
    expect(coordinator.guidanceFor('P1').strategy?.intent).toBe('Fresh strategy intent');
  });

  it('clears strategy when plan is invalidated via turnPlan onInvalidated', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    const req = request();
    coordinator.prepare(req);
    await coordinator.settled();

    expect(coordinator.guidanceFor('P1').strategy).not.toBeNull();

    // Now send a request where the pre-planned action is NOT in legal actions, causing turn plan invalidation
    const illegalReq = request({
      requestId: 'req-illegal',
      decidingPlayer: 'P1',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }], // Forest play is missing!
    });

    const plannedResponse = coordinator.tryExecutePlan(illegalReq);
    expect(plannedResponse).toBeNull();
    // Verification: strategy should be atomically cleared to null via onInvalidated callback
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
  });

  it('invalidates strategy and turn plan queue when active player executes a non-planned manual action', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    const req = request();
    coordinator.prepare(req);
    await coordinator.settled();

    expect(coordinator.guidanceFor('P1').strategy).not.toBeNull();

    // Active player P1 executes manual non-planned decision
    const manualReq = request({ requestId: 'req-manual', decidingPlayer: 'P1' });
    coordinator.recordDecision(manualReq, { requestId: 'req-manual', actionId: 2 }, 'primary');

    // Strategy and turn plan queue must both be cleared to null
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
    expect(coordinator.tryExecutePlan(request({ requestId: 'req-2' }))).toBeNull();
  });

  it('handles async prefetch promise rejection gracefully without crashing', async () => {
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockRejectedValue(new Error('API failure')),
    };
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    coordinator.prefetch('g1', 1, 'P1');
    await coordinator.settled();

    expect(engine.addDebug).toHaveBeenCalledWith(
      'decision',
      'strategist call failed for P1: API failure',
    );
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
  });

  it('does nothing when strategist is disabled or strategistClient is null', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;

    // Case 1: Disabled in config
    const disabledCoordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      { ...DEFAULT_AI_CONFIG, strategistEnabled: false },
    );
    disabledCoordinator.prepare(request());
    await disabledCoordinator.settled();

    expect(client.requestDecision).not.toHaveBeenCalled();
    expect(disabledCoordinator.guidanceFor('P1').strategy).toBeNull();

    // Case 2: Null client
    const nullCoordinator = new StrategyCoordinator(
      null,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );
    nullCoordinator.prepare(request());
    await nullCoordinator.settled();

    expect(nullCoordinator.guidanceFor('P1').strategy).toBeNull();
  });

  it('isolates strategy guidance to the planned player and returns strategy null for non-planned opponent seat', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    coordinator.prepare(request({ activePlayer: 'P1' }));
    await coordinator.settled();

    // Planned player P1 gets strategy guidance
    expect(coordinator.guidanceFor('P1').strategy).not.toBeNull();
    expect(coordinator.guidanceFor('P1').strategy?.intent).toContain('Develop mana');

    // Non-planned opponent player P2 gets strategy: null
    expect(coordinator.guidanceFor('P2').strategy).toBeNull();
  });

  it('cancel() aborts the in-flight call and blocks every future strategist attempt', async () => {
    let capturedSignal: AbortSignal | undefined;
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockImplementation((_prompt, _request, signal?: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {}); // never settles on its own — only `cancel()` ends it
      }),
    };
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    let enqueueSignal: AbortSignal | undefined;
    const queue = {
      enqueue: <T>(fn: () => Promise<T>, signal?: AbortSignal) => {
        enqueueSignal = signal;
        return fn();
      },
    };
    const coordinator = new StrategyCoordinator(client, queue, engine, DEFAULT_AI_CONFIG);

    coordinator.prefetch('g1', 1, 'P1');
    expect(capturedSignal?.aborted).toBe(false);
    expect(enqueueSignal).toBe(capturedSignal);

    coordinator.cancel();
    expect(capturedSignal?.aborted).toBe(true);

    // A halted/abandoned match must never resume prefetching — not this turn, not the next one.
    coordinator.prepare(request());
    coordinator.prefetch('g1', 2, 'P1');
    expect(client.requestDecision).toHaveBeenCalledTimes(1);
  });

  it('cancel() and drained() reach every outstanding call, not only the newest', async () => {
    const signals: AbortSignal[] = [];
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockImplementation((_prompt, _request, signal?: AbortSignal) => {
        if (signal !== undefined) signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }),
    };
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(client, queue, engine, DEFAULT_AI_CONFIG);

    coordinator.prefetch('g1', 1, 'P1');
    coordinator.prefetch('g1', 2, 'P2');
    expect(signals).toHaveLength(2);

    coordinator.cancel();
    await coordinator.drained();
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
  });

  it('truncates past decision history at maximum limit configured by strategyRecentDecisionLimit', () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      { ...DEFAULT_AI_CONFIG, strategyRecentDecisionLimit: 2 },
    );

    const r1 = request({
      turn: 1,
      legalActions: [{ id: 10, type: 'pass', description: 'Action 1' }],
    });
    const r2 = request({
      turn: 1,
      legalActions: [{ id: 20, type: 'pass', description: 'Action 2' }],
    });
    const r3 = request({
      turn: 1,
      legalActions: [{ id: 30, type: 'pass', description: 'Action 3' }],
    });

    coordinator.recordDecision(r1, { requestId: r1.requestId, actionId: 10 }, 'primary');
    coordinator.recordDecision(r2, { requestId: r2.requestId, actionId: 20 }, 'primary');
    coordinator.recordDecision(r3, { requestId: r3.requestId, actionId: 30 }, 'primary');

    const history = coordinator.guidanceFor('P1').recentDecisions;
    expect(history.length).toBe(2);
    expect(history[0]?.action).toBe('Action 2');
    expect(history[1]?.action).toBe('Action 3');
  });
});

/**
 * The whole-game decision digest (ADR 0022 §7). Distinct from `recentDecisions`, which is capped
 * at 8 because a tactician only needs the last few moves. A post-game review needs the *arc* of
 * the game, and a full game runs to thousands of decisions, most of them passes — so this is a
 * sampled history, and what it samples is the point.
 */
describe('StrategyCoordinator — whole-game decision digest', () => {
  function coordinatorForDigest(): StrategyCoordinator {
    const engine = { view: () => view, addDebug: () => {} } as unknown as Engine;
    return new StrategyCoordinator(
      null,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );
  }

  function record(
    coordinator: StrategyCoordinator,
    options: { turn: number; phase: DecisionRequest['phase']; type: string; description: string },
  ): void {
    const req = request({
      turn: options.turn,
      phase: options.phase,
      legalActions: [{ id: 1, type: options.type, description: options.description }],
    });
    coordinator.recordDecision(req, { requestId: req.requestId, actionId: 1 }, 'primary');
  }

  it('drops passes — the absence of a decision is not worth reviewing', () => {
    const coordinator = coordinatorForDigest();

    record(coordinator, { turn: 1, phase: 'precombatMain', type: 'pass', description: 'Pass' });
    record(coordinator, {
      turn: 1,
      phase: 'precombatMain',
      type: 'passAndYieldTurn',
      description: 'Yield',
    });

    expect(coordinator.digestFor('P1')).toHaveLength(0);
  });

  it('keeps one action per main phase but several per combat', () => {
    const coordinator = coordinatorForDigest();

    for (const n of [1, 2, 3]) {
      record(coordinator, {
        turn: 1,
        phase: 'precombatMain',
        type: 'castSpell',
        description: `main ${n}`,
      });
    }
    for (const n of [1, 2, 3, 4, 5]) {
      record(coordinator, {
        turn: 1,
        phase: 'combat',
        type: 'declareAttackers',
        description: `attack ${n}`,
      });
    }

    const actions = coordinator.digestFor('P1').map((entry) => entry.action);
    expect(actions).toEqual(['main 1', 'attack 1', 'attack 2', 'attack 3']);
  });

  it('keeps seats separate', () => {
    const coordinator = coordinatorForDigest();
    const p2 = request({
      decidingPlayer: 'P2',
      legalActions: [{ id: 1, type: 'castSpell', description: 'P2 casts' }],
    });

    record(coordinator, {
      turn: 1,
      phase: 'precombatMain',
      type: 'castSpell',
      description: 'P1 casts',
    });
    coordinator.recordDecision(p2, { requestId: p2.requestId, actionId: 1 }, 'primary');

    expect(coordinator.digestFor('P1').map((e) => e.action)).toEqual(['P1 casts']);
    expect(coordinator.digestFor('P2').map((e) => e.action)).toEqual(['P2 casts']);
  });

  it('thins the older half rather than dropping the early game', () => {
    // A review that cannot see the opening cannot answer "what did I do wrong", which is usually
    // a turn-3 question. Truncating the front is the obvious cap and the wrong one.
    const coordinator = coordinatorForDigest();
    for (let turn = 1; turn <= 200; turn++) {
      record(coordinator, {
        turn,
        phase: 'precombatMain',
        type: 'castSpell',
        description: `turn ${turn}`,
      });
    }

    const digest = coordinator.digestFor('P1');
    expect(digest.length).toBeLessThanOrEqual(80);
    // Turn 1 survives 200 turns of pressure on the cap.
    expect(digest[0]?.action).toBe('turn 1');
    expect(digest.at(-1)?.action).toBe('turn 200');
  });
});

describe('StrategyCoordinator — table diplomacy (ADR 0035 phase 4)', () => {
  const dealContext = {
    yourPromises: ["you won't attack P2 (deal deal-1, one round)"],
    promisesToYou: [],
    otherDeals: [],
    records: [],
    howToPropose: 'add dealProposal',
  };

  it('puts the table in the strategist prompt and hands back a proposal it makes', async () => {
    const client = strategist();
    const proposal = { to: 'P3', obligations: [], rounds: 1 };
    (client.requestDecision as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      response: {
        requestId: 'strategy',
        actionId: 0,
        turnStrategy: { intent: 'Make peace.', plannedActions: [], dealProposal: proposal },
      },
      meta: {
        model: 'm',
        promptTokens: 1,
        responseTokens: 1,
        latencyMs: 1,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(client, queue, engine, DEFAULT_AI_CONFIG);
    const roles: string[] = [];
    coordinator.diplomacyFor = (_seat, role) => {
      roles.push(role);
      return dealContext;
    };
    const proposals: unknown[] = [];
    coordinator.onDealProposal = (turn, seat, raw) => proposals.push({ turn, seat, raw });

    coordinator.prepare(request());
    await coordinator.settled();

    const prompt = (client.requestDecision as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ content: string }>;
    };
    expect(JSON.parse(prompt.messages.at(-1)!.content).tableDiplomacy).toEqual(dealContext);
    expect(roles).toContain('strategist');
    expect(proposals).toEqual([{ turn: 1, seat: 'P1', raw: proposal }]);
  });

  it('gives the tactician its deals only when it has some', () => {
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(strategist(), queue, engine, DEFAULT_AI_CONFIG);
    expect('deals' in coordinator.guidanceFor('P1')).toBe(false);
    coordinator.diplomacyFor = () => null;
    expect('deals' in coordinator.guidanceFor('P1')).toBe(false);
    coordinator.diplomacyFor = () => dealContext;
    expect(coordinator.guidanceFor('P1').deals).toEqual(dealContext);
  });

  it('leaves the strategist prompt exactly as it was in a game without deals', async () => {
    const plain = strategist();
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(plain, queue, engine, DEFAULT_AI_CONFIG);
    coordinator.prepare(request());
    await coordinator.settled();
    const prompt = (plain.requestDecision as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ content: string }>;
    };
    expect(prompt.messages[1]!.content).not.toContain('tableDiplomacy');
  });
});

describe('StrategyCoordinator — plans and deals made after them (ADR 0035)', () => {
  it('stops executing a plan once the seat has made a deal the plan never weighed', async () => {
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(strategist(), queue, engine, DEFAULT_AI_CONFIG);
    let promised = false;
    coordinator.diplomacyFor = () =>
      promised
        ? {
            yourPromises: ["you won't target P2 (deal deal-1, one round)"],
            promisesToYou: [],
            otherDeals: [],
            records: [],
          }
        : null;
    const req = request();
    coordinator.prepare(req);
    await coordinator.settled();
    // The deal is made after the plan was built, before its step runs.
    promised = true;
    expect(coordinator.tryExecutePlan(req)).toBeNull();
    // With the deals back as the plan saw them, the same step runs.
    promised = false;
    expect(coordinator.tryExecutePlan(req)?.actionId).toBe(1);
  });
});

describe('StrategyCoordinator — bot-led knobs (ADR 0039)', () => {
  const opponentView: PlayerView = {
    ...view,
    opponents: [
      {
        seat: 'P2',
        life: 40,
        handSize: 7,
        librarySize: 90,
        graveyard: [],
        commanders: [],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
    ],
  };
  function knobsClient(
    steering: unknown,
    plannedActions?: unknown[],
  ): {
    client: AiClient;
    resolve: () => void;
  } {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client: AiClient = {
      activeModel: 'm',
      requestDecision: vi.fn().mockImplementation(async () => {
        await gate;
        return {
          response: {
            requestId: 'strategy',
            actionId: 0,
            turnStrategy: {
              intent: 'Pressure P2.',
              ...(plannedActions === undefined ? {} : { plannedActions }),
              steering,
            },
          },
          meta: {
            model: 'm',
            promptTokens: 1,
            responseTokens: 1,
            latencyMs: 1,
            wasRetry: false,
            wasFallback: false,
            rawResponse: '{}',
          },
        } as AiCallResult;
      }),
    };
    return { client, resolve: release };
  }
  const engine = {
    view: vi.fn().mockReturnValue(opponentView),
    addDebug: vi.fn(),
  } as unknown as Engine;
  const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
  const botConfig = { ...DEFAULT_AI_CONFIG, tacticalMode: 'bot' as const };

  it('keeps knobs that arrive after the turn has moved on', async () => {
    const { client, resolve } = knobsClient({ aggression: 0.9, targetOrder: ['P2'] });
    const coordinator = new StrategyCoordinator(client, queue, engine, botConfig);
    coordinator.prepare(request({ turn: 1, activePlayer: 'P1' }));
    // P1's turn ends and P2's begins before the strategist answers.
    coordinator.prepare(request({ turn: 2, activePlayer: 'P2', decidingPlayer: 'P2' }));
    resolve();
    await coordinator.settled();
    await new Promise((r) => setTimeout(r, 0));
    expect(coordinator.steeringFor('P1')).toEqual({ aggression: 0.9, targetOrder: ['P2'] });
  });

  it('cleans knobs before they reach the plan, and drops junk', async () => {
    const { client, resolve } = knobsClient({
      aggression: 7,
      targetOrder: ['P2', 'P9'],
      hold: 'x'.repeat(10_000),
    });
    const coordinator = new StrategyCoordinator(client, queue, engine, botConfig);
    coordinator.prepare(request());
    resolve();
    await coordinator.settled();
    expect(coordinator.guidanceFor('P1').strategy?.steering).toEqual({
      aggression: 1,
      targetOrder: ['P2'],
    });
  });

  it('accepts a knobs-only answer in bot mode but not in model mode', async () => {
    for (const [config, expected] of [
      [botConfig, 'Pressure P2.'],
      [DEFAULT_AI_CONFIG, undefined],
    ] as const) {
      const { client, resolve } = knobsClient({ aggression: 0.5 });
      const coordinator = new StrategyCoordinator(client, queue, engine, config);
      coordinator.prepare(request());
      resolve();
      await coordinator.settled();
      expect(coordinator.guidanceFor('P1').strategy?.intent).toBe(expected);
    }
  });
});

describe('StrategyCoordinator — the tactician request, in shadow (ADR 0045)', () => {
  const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
  function flagClient(turnStrategy: unknown): AiClient {
    return {
      activeModel: 'm',
      requestDecision: vi.fn().mockResolvedValue({
        response: { requestId: 'strategy', actionId: 0, turnStrategy },
        meta: {
          model: 'm',
          promptTokens: 1,
          responseTokens: 1,
          latencyMs: 1,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{}',
        },
      }),
    };
  }
  const engine = (): Engine =>
    ({ view: vi.fn().mockReturnValue(view), addDebug: vi.fn() }) as unknown as Engine;
  const shadowConfig = {
    ...DEFAULT_AI_CONFIG,
    tacticalMode: 'bot' as const,
    strategistTacticianFlag: 'shadow' as const,
  };

  it('reads the request apart from the knobs, caps the reason and keeps it out of the plan', async () => {
    const e = engine();
    const coordinator = new StrategyCoordinator(
      flagClient({
        intent: 'Kill P2.',
        // Every knob is junk, so no steering is stored; the request still counts.
        steering: { aggression: 'max' },
        tacticianRequest: { reason: `Exact lethal needs ordering. ${'x'.repeat(400)}` },
      }),
      queue,
      e,
      shadowConfig,
    );
    coordinator.prepare(request());
    await coordinator.settled();
    expect(coordinator.tacticianRequests).toHaveLength(1);
    const [record] = coordinator.tacticianRequests;
    expect(record).toMatchObject({ turn: 1, seat: 'P1', wake: ['first knobs'], knobs: false });
    expect(record!.reason.length).toBe(TACTICIAN_REQUEST_REASON_LIMIT);
    expect(JSON.stringify(coordinator.guidanceFor('P1').strategy ?? {})).not.toContain(
      'Exact lethal',
    );
    expect(e.addDebug).toHaveBeenCalledWith(
      'decision',
      expect.stringContaining('asked for the tactician'),
      expect.objectContaining({ wake: ['first knobs'] }),
    );
  });

  it('ignores a malformed request and never acts on one', () => {
    expect(readTacticianRequest({ tacticianRequest: { reason: '  ' } })).toBeNull();
    expect(readTacticianRequest({ tacticianRequest: 'please' })).toBeNull();
    expect(readTacticianRequest(undefined)).toBeNull();
    expect(readTacticianRequest({ tacticianRequest: { reason: ' Go. ' } })).toEqual({
      reason: 'Go.',
    });
  });

  it('offers the field in the primer only when the flag is in shadow', () => {
    const on = assembleStrategistPrompt(request(), view, [], undefined, {
      botSteering: true,
      tacticianFlag: true,
    });
    const off = assembleStrategistPrompt(request(), view, [], undefined, { botSteering: true });
    expect(on.messages[0]!.content).toContain('tacticianRequest');
    expect(off.messages[0]!.content).not.toContain('tacticianRequest');
  });
});

describe('StrategyCoordinator — wake reasons under everyTurn (ADR 0045)', () => {
  it("simulates onChange's reuse limit on a quiet table", async () => {
    const e = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const client: AiClient = {
      activeModel: 'm',
      requestDecision: vi.fn().mockImplementation((_p, r: DecisionRequest) =>
        Promise.resolve({
          response: {
            requestId: r.requestId,
            actionId: 0,
            turnStrategy: {
              intent: 'x',
              steering: { aggression: 0.5 },
              tacticianRequest: { reason: 'every turn' },
            },
          },
          meta: {
            model: 'm',
            promptTokens: 1,
            responseTokens: 1,
            latencyMs: 1,
            wasRetry: false,
            wasFallback: false,
            rawResponse: '{}',
          },
        }),
      ),
    };
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      e,
      {
        ...DEFAULT_AI_CONFIG,
        tacticalMode: 'bot',
        strategistReplan: 'everyTurn',
        strategistMaxReuseTurns: 2,
        strategistTacticianFlag: 'shadow',
      },
    );
    for (let turn = 1; turn <= 5; turn++) {
      coordinator.prepare(request({ turn, requestId: `r${turn}` }));
      await coordinator.drained();
    }
    // First knobs, then two quiet turns onChange would reuse, then the reuse limit, then quiet.
    expect(coordinator.tacticianRequests.map((r) => r.wake)).toEqual([
      ['first knobs'],
      [],
      [],
      ['reuse limit'],
      [],
    ]);
  });
});

/**
 * S5 (2026-11-15): the stable-prefix layout used to delete `yourStrategyProfile` from the
 * observation and re-add it only when a versioned profile existed, so a seat that had only the
 * legacy archetype tag lost it. These guard the layout as the production default.
 */
describe('StrategyCoordinator with the stable-prefix layout', () => {
  async function promptFor(config = DEFAULT_AI_CONFIG) {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(
      client,
      queue,
      engine,
      config,
      undefined,
      undefined,
      new Map([['P1', 'Gruul dragon tribal aggro']]),
    );
    coordinator.prepare(request());
    await coordinator.settled();
    const call = vi.mocked(client.requestDecision).mock.calls[0]!;
    return call[0];
  }

  it('is the default layout', () => {
    expect(DEFAULT_AI_CONFIG.providerPromptCacheLayoutEnabled).toBe(true);
  });

  it('keeps the legacy archetype tag, in the stable prefix', async () => {
    const prompt = await promptFor();
    expect(prompt.promptCache?.version).toBe('stable-prefix-v2');
    const prefix = JSON.parse(prompt.messages[1]!.content);
    expect(prefix.immutableContext.yourStrategyProfile.archetype).toBe('Gruul dragon tribal aggro');
    expect(prefix.immutableContext.strategyTask.requirements[0]).toContain('yourStrategyProfile');
    const observation = JSON.parse(prompt.messages.at(-1)!.content);
    expect(observation).not.toHaveProperty('yourStrategyProfile');
    expect(observation).not.toHaveProperty('strategyTask');
  });

  it('sends the same payload values as the plain layout, only moved', async () => {
    const plain = await promptFor({
      ...DEFAULT_AI_CONFIG,
      providerPromptCacheLayoutEnabled: false,
    });
    const cached = await promptFor();
    const plainPayload = JSON.parse(plain.messages[1]!.content);
    const merged = {
      ...JSON.parse(cached.messages.at(-1)!.content),
      ...JSON.parse(cached.messages[1]!.content).immutableContext,
    };
    expect(cached.messages[0]).toEqual(plain.messages[0]);
    expect(Object.keys(merged).sort()).toEqual(Object.keys(plainPayload).sort());
    for (const key of Object.keys(plainPayload)) expect(merged[key]).toEqual(plainPayload[key]);
  });
});
