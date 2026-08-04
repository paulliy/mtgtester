import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '@mtg/engine';
import type { DecisionRequest, PlayerView } from '@mtg/shared';
import type { AiClient } from './client';
import { DEFAULT_AI_CONFIG } from './config';
import { StrategyCoordinator } from './strategy-coordinator';

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
    const coordinator = new StrategyCoordinator(client, queue, engine, DEFAULT_AI_CONFIG, undefined, 'P1');
    const req = request();

    coordinator.prepare(req);
    await coordinator.settled();

    expect(client.requestDecision).not.toHaveBeenCalled();
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
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
    let resolveFirst!: (val: any) => void;
    const promise1 = new Promise<any>((resolve) => {
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
      meta: { model: 'test', promptTokens: 10, responseTokens: 10, latencyMs: 5, wasRetry: false, wasFallback: false, rawResponse: '{}' },
    });

    await coordinator.settled();

    // The stale response must NOT overwrite the replanned strategy
    expect(coordinator.guidanceFor('P1').strategy?.intent).toBe('Replanned strategy intent');
  });

  it('prevents out-of-order re-plans from overwriting fresh strategies', async () => {
    let resolveFirst!: (val: any) => void;
    let resolveSecond!: (val: any) => void;

    const promise1 = new Promise<any>((resolve) => { resolveFirst = resolve; });
    const promise2 = new Promise<any>((resolve) => { resolveSecond = resolve; });

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
      meta: { model: 'test', promptTokens: 10, responseTokens: 10, latencyMs: 5, wasRetry: false, wasFallback: false, rawResponse: '{}' },
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
      meta: { model: 'test', promptTokens: 10, responseTokens: 10, latencyMs: 5, wasRetry: false, wasFallback: false, rawResponse: '{}' },
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

    const r1 = request({ turn: 1, legalActions: [{ id: 10, type: 'pass', description: 'Action 1' }] });
    const r2 = request({ turn: 1, legalActions: [{ id: 20, type: 'pass', description: 'Action 2' }] });
    const r3 = request({ turn: 1, legalActions: [{ id: 30, type: 'pass', description: 'Action 3' }] });

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
      { enqueue: <T,>(fn: () => Promise<T>) => fn() },
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
      turn: 1, phase: 'precombatMain', type: 'passAndYieldTurn', description: 'Yield',
    });

    expect(coordinator.digestFor('P1')).toHaveLength(0);
  });

  it('keeps one action per main phase but several per combat', () => {
    const coordinator = coordinatorForDigest();

    for (const n of [1, 2, 3]) {
      record(coordinator, {
        turn: 1, phase: 'precombatMain', type: 'castSpell', description: `main ${n}`,
      });
    }
    for (const n of [1, 2, 3, 4, 5]) {
      record(coordinator, {
        turn: 1, phase: 'combat', type: 'declareAttackers', description: `attack ${n}`,
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
      turn: 1, phase: 'precombatMain', type: 'castSpell', description: 'P1 casts',
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
        turn, phase: 'precombatMain', type: 'castSpell', description: `turn ${turn}`,
      });
    }

    const digest = coordinator.digestFor('P1');
    expect(digest.length).toBeLessThanOrEqual(80);
    // Turn 1 survives 200 turns of pressure on the cap.
    expect(digest[0]?.action).toBe('turn 1');
    expect(digest.at(-1)?.action).toBe('turn 200');
  });
});
