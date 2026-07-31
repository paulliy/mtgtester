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
});
