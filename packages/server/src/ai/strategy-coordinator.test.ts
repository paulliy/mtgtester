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
  it('calls the strategist once per turn and executes an exact legal planned action', async () => {
    const client = strategist();
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(client, queue, engine, DEFAULT_AI_CONFIG);
    const req = request();

    await coordinator.prepare(req);
    await coordinator.prepare({ ...req, requestId: 'r2' });

    expect(client.requestDecision).toHaveBeenCalledTimes(1);
    expect(engine.view).toHaveBeenCalledWith('P1');
    expect(coordinator.guidanceFor('P1').strategy?.intent).toContain('Develop mana');
    expect(coordinator.tryExecutePlan(req)?.actionId).toBe(1);
  });

  it('invalidates the active plan when another seat takes a non-pass action', async () => {
    const engine = {
      view: vi.fn().mockReturnValue(view),
      addDebug: vi.fn(),
    } as unknown as Engine;
    const coordinator = new StrategyCoordinator(
      strategist(),
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      engine,
      DEFAULT_AI_CONFIG,
    );
    const req = request();
    await coordinator.prepare(req);

    const opponent = request({
      requestId: 'opp',
      decidingPlayer: 'P2',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 2, type: 'castSpell', description: 'Cast Giant Growth' },
      ],
    });
    coordinator.recordDecision(opponent, { requestId: opponent.requestId, actionId: 2 }, 'primary');

    expect(coordinator.guidanceFor('P1').strategy).toBeNull();
    expect(coordinator.tryExecutePlan({ ...req, requestId: 'after' })).toBeNull();
  });
});
