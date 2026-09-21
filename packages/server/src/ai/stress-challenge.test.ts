import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '@mtg/engine';
import type { DecisionRequest, PlayerView } from '@mtg/shared';
import type { AiClient } from './client';

type AiCallResult = Awaited<ReturnType<AiClient['requestDecision']>>;
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

function makeRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: 'req-1',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose action',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass priority' },
      { id: 1, type: 'playLand', description: 'Play Forest' },
      { id: 2, type: 'castSpell', description: 'Cast Grizzly Bears' },
    ],
    ...overrides,
  };
}

describe('Empirical Stress Testing (R1 & R3)', () => {
  it('Stress Test 1a: Rapid back-to-back opponent interventions reject all in-flight stale plans', async () => {
    let resolveCall1!: (val: AiCallResult) => void;
    let resolveCall2!: (val: AiCallResult) => void;

    const promise1 = new Promise<AiCallResult>((r) => {
      resolveCall1 = r;
    });
    const promise2 = new Promise<AiCallResult>((r) => {
      resolveCall2 = r;
    });

    let callCount = 0;
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? promise1 : promise2;
      }),
    };
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    const req = makeRequest();
    coordinator.prepare(req); // Call 1 (gen 1) started

    // Opponent 1 intervenes -> triggers Call 2 (gen 2) re-plan
    const opp1 = makeRequest({
      requestId: 'opp1',
      decidingPlayer: 'P2',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass' },
        { id: 10, type: 'castSpell', description: 'Cast Instant 1' },
      ],
    });
    coordinator.recordDecision(opp1, { requestId: 'opp1', actionId: 10 }, 'primary');

    // Opponent 2 intervenes IMMEDIATELY before Call 1 or Call 2 resolve
    const opp2 = makeRequest({
      requestId: 'opp2',
      decidingPlayer: 'P3',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass' },
        { id: 11, type: 'castSpell', description: 'Cast Instant 2' },
      ],
    });
    coordinator.recordDecision(opp2, { requestId: 'opp2', actionId: 11 }, 'primary');

    expect(client.requestDecision).toHaveBeenCalledTimes(2);

    // Call 1 resolves (stale)
    resolveCall1({
      response: {
        requestId: 'strategy-1',
        actionId: 0,
        turnStrategy: {
          intent: 'Call 1 Intent',
          plannedActions: [{ type: 'playLand', name: 'Forest' }],
        },
      },
      meta: {
        model: 'm',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });
    await promise1;

    // Call 2 resolves (stale because P3 intervened after Call 2 started)
    resolveCall2({
      response: {
        requestId: 'strategy-2',
        actionId: 0,
        turnStrategy: {
          intent: 'Call 2 Intent',
          plannedActions: [{ type: 'playLand', name: 'Forest' }],
        },
      },
      meta: {
        model: 'm',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });
    await promise2;

    // Both plans must be rejected! Strategy must remain null.
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
    expect(coordinator.tryExecutePlan(req)).toBeNull();
  });

  it('Stress Test 1b: Multiple rapid interventions cap re-plans at 1 per turn', async () => {
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockResolvedValue({
        response: {
          requestId: 'strat',
          actionId: 0,
          turnStrategy: { intent: 'Strategy intent', plannedActions: [] },
        },
        meta: {
          model: 'm',
          promptTokens: 10,
          responseTokens: 10,
          latencyMs: 5,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{}',
        },
      }),
    };
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    coordinator.prepare(makeRequest());
    await coordinator.settled();

    // 5 rapid opponent interventions
    for (let i = 1; i <= 5; i++) {
      const opp = makeRequest({
        requestId: `opp-${i}`,
        decidingPlayer: `P${(i % 3) + 2}`,
        legalActions: [
          { id: 0, type: 'pass', description: 'Pass' },
          { id: 100 + i, type: 'castSpell', description: `Cast Spell ${i}` },
        ],
      });
      coordinator.recordDecision(opp, { requestId: opp.requestId, actionId: 100 + i }, 'primary');
      await coordinator.settled();
    }

    // Must be exactly 2 calls: initial call + 1 re-plan
    expect(client.requestDecision).toHaveBeenCalledTimes(2);
  });

  it('Stress Test 2a: Reverse order promise settlement across 3 turn transitions', async () => {
    const resolvers: Array<(val: AiCallResult) => void> = [];
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      }),
    };
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    // Turn 1, P1
    coordinator.prepare(makeRequest({ turn: 1, activePlayer: 'P1' }));
    // Turn 2, P2
    coordinator.prepare(makeRequest({ turn: 2, activePlayer: 'P2' }));
    // Turn 3, P3
    coordinator.prepare(makeRequest({ turn: 3, activePlayer: 'P3' }));

    expect(resolvers.length).toBe(3);

    // Resolve in reverse order: Turn 3 first, Turn 1 second, Turn 2 third
    resolvers[2]?.({
      response: {
        requestId: 'strat-t3',
        actionId: 0,
        turnStrategy: { intent: 'Turn 3 Strategy', plannedActions: [] },
      },
      meta: {
        model: 'm',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(coordinator.guidanceFor('P3').strategy?.intent).toBe('Turn 3 Strategy');

    // Resolve Turn 1 (stale)
    resolvers[0]?.({
      response: {
        requestId: 'strat-t1',
        actionId: 0,
        turnStrategy: { intent: 'Turn 1 Strategy', plannedActions: [] },
      },
      meta: {
        model: 'm',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(coordinator.guidanceFor('P3').strategy?.intent).toBe('Turn 3 Strategy');

    // Resolve Turn 2 (stale)
    resolvers[1]?.({
      response: {
        requestId: 'strat-t2',
        actionId: 0,
        turnStrategy: { intent: 'Turn 2 Strategy', plannedActions: [] },
      },
      meta: {
        model: 'm',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(coordinator.guidanceFor('P3').strategy?.intent).toBe('Turn 3 Strategy');
  });

  it('Stress Test 3: Turn change mid-flight rejects turn 1 strategist completion', async () => {
    let resolveTurn1!: (val: AiCallResult) => void;
    let resolveTurn2!: (val: AiCallResult) => void;
    const promise1 = new Promise<AiCallResult>((r) => {
      resolveTurn1 = r;
    });
    const promise2 = new Promise<AiCallResult>((r) => {
      resolveTurn2 = r;
    });

    let count = 0;
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockImplementation(() => {
        count++;
        return count === 1 ? promise1 : promise2;
      }),
    };
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    // Turn 1, P1 starts strategist call
    coordinator.prepare(makeRequest({ turn: 1, activePlayer: 'P1' }));

    // Board advances to Turn 2, P2 while Turn 1 call is still running
    coordinator.prefetch('g1', 2, 'P2');

    // Resolve Turn 1 call (stale)
    resolveTurn1({
      response: {
        requestId: 'strat-t1',
        actionId: 0,
        turnStrategy: {
          intent: 'Turn 1 Stale Intent',
          plannedActions: [{ type: 'playLand', name: 'Forest' }],
        },
      },
      meta: {
        model: 'm',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });

    await promise1;

    // Guidance for P1 must be null (since Turn 1 is no longer plannedPlayer)
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
    // Guidance for P2 must NOT be Turn 1 Stale Intent
    expect(coordinator.guidanceFor('P2').strategy?.intent).toBeUndefined();

    // Now resolve Turn 2 call
    resolveTurn2({
      response: {
        requestId: 'strat-t2',
        actionId: 0,
        turnStrategy: { intent: 'Turn 2 Fresh Intent', plannedActions: [] },
      },
      meta: {
        model: 'm',
        promptTokens: 10,
        responseTokens: 10,
        latencyMs: 5,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    });
    await promise2;

    expect(coordinator.guidanceFor('P2').strategy?.intent).toBe('Turn 2 Fresh Intent');
  });

  it('Stress Test 4: Active player manual deviation invalidates plan queue and strategy (R3 verified)', async () => {
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockResolvedValue({
        response: {
          requestId: 'strat',
          actionId: 0,
          turnStrategy: {
            intent: 'Play Forest first, then cast Grizzly Bears',
            plannedActions: [
              { type: 'playLand', name: 'Forest', phase: 'precombatMain' },
              { type: 'castSpell', name: 'Grizzly Bears', phase: 'precombatMain' },
            ],
          },
        },
        meta: {
          model: 'm',
          promptTokens: 10,
          responseTokens: 10,
          latencyMs: 5,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{}',
        },
      }),
    };
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    const req = makeRequest();
    coordinator.prepare(req);
    await coordinator.settled();

    // Active player P1 does NOT call tryExecutePlan, but manually takes a different action: actionId 2 (Cast Grizzly Bears)
    coordinator.recordDecision(req, { requestId: req.requestId, actionId: 2 }, 'primary');

    // Active player manual deviation clears queue and invalidates strategy
    const nextReq = makeRequest({ requestId: 'req-2' });
    const executedNext = coordinator.tryExecutePlan(nextReq);

    expect(executedNext).toBeNull();
    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
  });

  it('Stress Test 5: Strategist throwing error does not break coordinator', async () => {
    const client: AiClient = {
      activeModel: 'test-model',
      requestDecision: vi.fn().mockRejectedValue(new Error('API Timeout 504')),
    };
    const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );

    coordinator.prepare(makeRequest());
    await coordinator.settled();

    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
    expect(coordinator.tryExecutePlan(makeRequest())).toBeNull();
    expect(engine.addDebug).toHaveBeenCalledWith(
      'decision',
      expect.stringContaining('strategist call failed for P1: API Timeout 504'),
    );
  });
});
