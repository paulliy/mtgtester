import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import { OpenAiDecisionProvider } from './provider';
import type { AiClient } from './client';
import {
  AuthenticationError,
  DailyQuotaExhaustedError,
  HttpError,
  NoAvailableModelError,
} from './errors';
import { DEFAULT_AI_CONFIG } from './config';
import { StrategyCoordinator } from './strategy-coordinator';
import { AiCallLogger } from './logger';
import type { Engine } from '@mtg/engine';
import type { JevComparison, JevTacticalPolicy } from './jev-policy';

describe('OpenAiDecisionProvider', () => {
  const mockEngine = {
    view: vi.fn().mockReturnValue({
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
    }),
  } as unknown as Engine;

  const mockQueue = {
    enqueue: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
  };

  beforeEach(() => {
    mockQueue.enqueue.mockClear();
  });

  const fixtureReq: DecisionRequest = {
    requestId: 'req-1',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'You have priority.',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass priority' },
      { id: 1, type: 'castSpell', description: 'Cast Spell' },
    ],
  };

  it('returns valid primary decision on first try', async () => {
    const mockClient: AiClient = {
      activeModel: 'm1',
      requestDecision: vi.fn().mockResolvedValue({
        response: { requestId: 'req-1', actionId: 0, note: 'Pass' },
        meta: {
          model: 'm1',
          promptTokens: 10,
          responseTokens: 5,
          latencyMs: 100,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{"actionId":0}',
        },
      }),
    };

    const provider = new OpenAiDecisionProvider(
      mockClient,
      mockQueue,
      mockEngine,
      DEFAULT_AI_CONFIG,
    );
    const res = await provider.decide(fixtureReq);

    expect(res.actionId).toBe(0);
    expect(mockEngine.view).toHaveBeenCalledWith('P1');
    expect(mockClient.requestDecision).toHaveBeenCalledTimes(1);
  });

  it('uses a validated Jev answer without calling the chat tactician', async () => {
    const mockClient: AiClient = {
      activeModel: 'chat-model',
      requestDecision: vi.fn(),
    };
    const jevPolicy: JevTacticalPolicy = {
      decide: vi.fn().mockResolvedValue({
        kind: 'answered',
        response: { requestId: 'req-1', actionId: 1 },
        meta: {
          model: 'typesafe/jev-1.13',
          requestedModel: 'typesafe/jev-1.13',
          responseModel: 'typesafe/jev-1.13',
          promptTokens: 100,
          responseTokens: 5,
          latencyMs: 200,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{}',
          costSource: 'unknown',
        },
        classification: {
          shape: 'action_only',
          jevSupported: true,
          reason: 'supported_action_only',
          actionCount: 2,
          targetSlotCount: 0,
        },
        confidence: 0.9,
        topTwoMargin: 0.8,
        probabilities: { action_0: 0.1, action_1: 0.9 },
      }),
    };
    const logger = new AiCallLogger(null, 'g1');
    const provider = new OpenAiDecisionProvider(
      mockClient,
      mockQueue,
      mockEngine,
      DEFAULT_AI_CONFIG,
      logger,
      undefined,
      undefined,
      { policy: jevPolicy, mode: 'active' },
    );

    await expect(provider.decide(fixtureReq)).resolves.toMatchObject({ actionId: 1 });
    expect(mockClient.requestDecision).not.toHaveBeenCalled();
    expect(logger.sourceFor('req-1')).toBe('jev');
  });

  it('falls through from Jev to the original chat tactician', async () => {
    const mockClient: AiClient = {
      activeModel: 'chat-model',
      requestDecision: vi.fn().mockResolvedValue({
        response: { requestId: 'req-1', actionId: 0 },
        meta: {
          model: 'chat-model',
          promptTokens: 10,
          responseTokens: 5,
          latencyMs: 100,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{"actionId":0}',
        },
      }),
    };
    const jevPolicy: JevTacticalPolicy = {
      decide: vi.fn().mockResolvedValue({
        kind: 'fallthrough',
        reason: 'low_confidence',
        detail: 'confidence=0.2, margin=0.1',
        classification: {
          shape: 'action_only',
          jevSupported: true,
          reason: 'supported_action_only',
          actionCount: 2,
          targetSlotCount: 0,
        },
      }),
    };
    const provider = new OpenAiDecisionProvider(
      mockClient,
      mockQueue,
      mockEngine,
      DEFAULT_AI_CONFIG,
      undefined,
      undefined,
      undefined,
      { policy: jevPolicy, mode: 'active' },
    );

    await expect(provider.decide(fixtureReq)).resolves.toMatchObject({ actionId: 0 });
    expect(jevPolicy.decide).toHaveBeenCalledTimes(1);
    expect(mockClient.requestDecision).toHaveBeenCalledTimes(1);
  });

  it('runs Jev shadow evidence without changing the chat tactician answer', async () => {
    const mockClient: AiClient = {
      activeModel: 'chat-model',
      requestDecision: vi.fn().mockResolvedValue({
        response: { requestId: 'req-1', actionId: 0 },
        meta: {
          model: 'chat-model',
          promptTokens: 10,
          responseTokens: 5,
          latencyMs: 100,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{"actionId":0}',
        },
      }),
    };
    const jevPolicy: JevTacticalPolicy = {
      decide: vi.fn().mockResolvedValue({
        kind: 'answered',
        response: { requestId: 'req-1', actionId: 1 },
        meta: {
          model: 'typesafe/jev-1.13',
          promptTokens: 10,
          responseTokens: 1,
          latencyMs: 10,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{}',
        },
        classification: {
          shape: 'action_only',
          jevSupported: true,
          reason: 'supported_action_only',
          actionCount: 2,
          targetSlotCount: 0,
        },
        confidence: 0.99,
        topTwoMargin: 0.98,
        probabilities: { action_0: 0.01, action_1: 0.99 },
      }),
    };
    const provider = new OpenAiDecisionProvider(
      mockClient,
      mockQueue,
      mockEngine,
      DEFAULT_AI_CONFIG,
      undefined,
      undefined,
      undefined,
      { policy: jevPolicy, mode: 'shadow' },
    );

    await expect(provider.decide(fixtureReq)).resolves.toMatchObject({ actionId: 0 });
    expect(jevPolicy.decide).toHaveBeenCalledTimes(1);
    expect(mockClient.requestDecision).toHaveBeenCalledTimes(1);
  });

  it('records whether shadow Jev agreed with the chat tactician', async () => {
    const mockClient: AiClient = {
      activeModel: 'chat-model',
      requestDecision: vi.fn().mockResolvedValue({
        response: { requestId: 'req-1', actionId: 0 },
        meta: {
          model: 'chat-model',
          promptTokens: 10,
          responseTokens: 5,
          latencyMs: 100,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{"actionId":0}',
        },
      }),
    };
    const jevPolicy: JevTacticalPolicy = {
      decide: vi.fn().mockResolvedValue({
        kind: 'answered',
        response: { requestId: 'req-1', actionId: 1 },
        meta: {
          model: 'typesafe/jev-1.13',
          promptTokens: 10,
          responseTokens: 1,
          latencyMs: 10,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{}',
        },
        classification: {
          shape: 'action_only',
          jevSupported: true,
          reason: 'supported_action_only',
          actionCount: 2,
          targetSlotCount: 0,
        },
        confidence: 0.7,
        topTwoMargin: 0.4,
        probabilities: { action_0: 0.3, action_1: 0.7 },
      }),
    };
    const comparisons: JevComparison[] = [];
    const provider = new OpenAiDecisionProvider(
      mockClient,
      mockQueue,
      mockEngine,
      DEFAULT_AI_CONFIG,
      undefined,
      undefined,
      undefined,
      { policy: jevPolicy, mode: 'shadow', onComparison: (c) => comparisons.push(c) },
    );

    await expect(provider.decide(fixtureReq)).resolves.toMatchObject({ actionId: 0 });
    await vi.waitFor(() => expect(comparisons).toHaveLength(1));
    expect(comparisons[0]).toMatchObject({
      playedBy: 'model',
      playedActionId: 0,
      jevOutcome: 'answered',
      jevActionId: 1,
      agreed: false,
      confidence: 0.7,
    });
  });

  it('retries once with corrective error message when primary is invalid', async () => {
    let calls = 0;
    const mockClient: AiClient = {
      activeModel: 'm1',
      requestDecision: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          // Invalid actionId
          return {
            response: { requestId: 'req-1', actionId: 99 },
            meta: { rawResponse: '{"actionId":99}' },
          };
        }
        return {
          response: { requestId: 'req-1', actionId: 0 },
          meta: { rawResponse: '{"actionId":0}' },
        };
      }),
    };

    const provider = new OpenAiDecisionProvider(
      mockClient,
      mockQueue,
      mockEngine,
      DEFAULT_AI_CONFIG,
    );
    const res = await provider.decide(fixtureReq);

    expect(res.actionId).toBe(0);
    expect(calls).toBe(2);
  });

  it('falls back to the heuristic bot when retries also fail', async () => {
    const mockClient: AiClient = {
      activeModel: 'm1',
      requestDecision: vi.fn().mockResolvedValue({
        response: { requestId: 'req-1', actionId: 99 },
        meta: { rawResponse: '{"actionId":99}' },
      }),
    };

    const provider = new OpenAiDecisionProvider(
      mockClient,
      mockQueue,
      mockEngine,
      DEFAULT_AI_CONFIG,
    );
    const res = await provider.decide(fixtureReq);

    // The fallback is scored, not a reflex to `pass` (ADR 0023 item 9): casting a free spell
    // outscores passing, so that's what comes back even though `pass` (id 0) is on the menu.
    expect(res.actionId).toBe(1);
    expect(res.note).toContain('Heuristic bot');
  });

  describe('a request that never returns a response at all (§7.7 step 3)', () => {
    /**
     * The §7.7 chain used to cover only responses that arrived and failed validation. A
     * transport-layer failure propagated out of `decide()` and ended the game — which is what
     * `HTTP 400 json_validate_failed` did at turn 22 of a real Groq run.
     */
    const throwingClient = (err: Error): AiClient => ({
      activeModel: 'm1',
      requestDecision: vi.fn().mockRejectedValue(err),
    });

    it('falls back to the heuristic bot instead of ending the game', async () => {
      const provider = new OpenAiDecisionProvider(
        throwingClient(new HttpError(400, '{"code":"json_validate_failed"}')),
        mockQueue,
        mockEngine,
        DEFAULT_AI_CONFIG,
      );

      const res = await provider.decide(fixtureReq);
      expect(res.actionId).toBe(1); // "Cast Spell" — scores above `pass` (id 0)
    });

    it.each([
      ['daily quota', new DailyQuotaExhaustedError()],
      ['no available model', new NoAvailableModelError(['m1'])],
      ['authentication', new AuthenticationError()],
    ])(
      'falls back to the heuristic bot on terminal %s error to keep simulation going',
      async (_l, err) => {
        const provider = new OpenAiDecisionProvider(
          throwingClient(err),
          mockQueue,
          mockEngine,
          DEFAULT_AI_CONFIG,
        );

        const res = await provider.decide(fixtureReq);
        expect(res.actionId).toBe(1); // "Cast Spell" — scores above `pass` (id 0)
      },
    );
  });
});

describe('OpenAiDecisionProvider — local short-circuits', () => {
  const mockEngine = {
    view: vi.fn().mockReturnValue({
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
    }),
  } as unknown as Engine;

  /** An upkeep where the only alternative to passing is holding an instant. */
  const idleUpkeep: DecisionRequest = {
    requestId: 'req-h1',
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
      {
        id: 1,
        type: 'castSpell',
        description: "Cast Predator's Strike",
        data: { instantSpeed: true },
      },
    ],
  };

  /** A real decision no heuristic covers: a sorcery-speed cast alongside a land drop. */
  const realChoice: DecisionRequest = {
    ...idleUpkeep,
    requestId: 'req-m1',
    phase: 'precombatMain',
    step: null,
    activePlayer: 'P1',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass priority' },
      { id: 1, type: 'playLand', description: 'Play Forest' },
      {
        id: 2,
        type: 'castSpell',
        description: 'Cast Tor Giant ({3}{R})',
        data: { instantSpeed: false },
      },
    ],
  };

  function makeQueue(): { enqueue: ReturnType<typeof vi.fn> } {
    return { enqueue: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()) };
  }

  function makeClient(actionId = 0): AiClient {
    return {
      activeModel: 'm1',
      requestDecision: vi.fn().mockImplementation((_prompt, request: DecisionRequest) =>
        Promise.resolve({
          response: { requestId: request.requestId, actionId },
          meta: {
            model: 'm1',
            promptTokens: 10,
            responseTokens: 5,
            latencyMs: 100,
            wasRetry: false,
            wasFallback: false,
            rawResponse: `{"actionId":${actionId}}`,
          },
        }),
      ),
    };
  }

  it('answers a heuristic-covered decision without touching the queue', async () => {
    const queue = makeQueue();
    const client = makeClient();
    const provider = new OpenAiDecisionProvider(client, queue, mockEngine, DEFAULT_AI_CONFIG);

    const res = await provider.decide(idleUpkeep);

    expect(res.actionId).toBe(0);
    expect(res.note).toContain('Heuristic');
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(client.requestDecision).not.toHaveBeenCalled();
  });

  it('still records the skipped call so the savings are measurable', async () => {
    const logger = new AiCallLogger(null, 'g1');
    const provider = new OpenAiDecisionProvider(
      makeClient(),
      makeQueue(),
      mockEngine,
      DEFAULT_AI_CONFIG,
      logger,
    );

    await provider.decide(idleUpkeep);

    expect(logger.summary()).toMatchObject({
      totalDecisions: 1,
      totalCalls: 0,
      skippedCalls: 1,
    });
  });

  it('calls the model when heuristics are disabled', async () => {
    const queue = makeQueue();
    const provider = new OpenAiDecisionProvider(
      makeClient(),
      queue,
      mockEngine,
      { ...DEFAULT_AI_CONFIG, heuristicsEnabled: false, decisionCacheEnabled: false },
      undefined,
    );

    await provider.decide(idleUpkeep);

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('serves a repeat of the same decision from cache instead of calling again', async () => {
    const queue = makeQueue();
    const client = makeClient(1);
    const provider = new OpenAiDecisionProvider(client, queue, mockEngine, DEFAULT_AI_CONFIG);

    const first = await provider.decide(realChoice);
    const second = await provider.decide({ ...realChoice, requestId: 'req-m2', turn: 12 });

    expect(first.actionId).toBe(1);
    expect(second.actionId).toBe(1);
    expect(second.requestId).toBe('req-m2');
    expect(second.note).toContain('Cache');
    expect(client.requestDecision).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not cache an answer whose deals changed while the model was thinking', async () => {
    const queue = makeQueue();
    const client = makeClient(1);
    const coordinator = new StrategyCoordinator(null, queue, mockEngine, DEFAULT_AI_CONFIG);
    let promises: string[] = [];
    coordinator.diplomacyFor = () =>
      promises.length === 0
        ? null
        : { yourPromises: promises, promisesToYou: [], otherDeals: [], records: [] };
    const answer = client.requestDecision as ReturnType<typeof vi.fn>;
    const respond = answer.getMockImplementation()!;
    // A deal is made while the first call is in flight.
    answer.mockImplementationOnce((prompt: unknown, request: DecisionRequest) => {
      promises = ["you won't attack P2 (deal deal-1, one round)"];
      return respond(prompt, request);
    });
    const provider = new OpenAiDecisionProvider(
      client,
      queue,
      mockEngine,
      DEFAULT_AI_CONFIG,
      undefined,
      undefined,
      coordinator,
    );

    await provider.decide(realChoice);
    const second = await provider.decide({ ...realChoice, requestId: 'req-m2', turn: 12 });

    expect(second.note ?? '').not.toContain('Cache');
    expect(client.requestDecision).toHaveBeenCalledTimes(2);
  });

  it('calls the model again when the cache is disabled', async () => {
    const queue = makeQueue();
    const provider = new OpenAiDecisionProvider(makeClient(1), queue, mockEngine, {
      ...DEFAULT_AI_CONFIG,
      decisionCacheEnabled: false,
    });

    await provider.decide(realChoice);
    await provider.decide({ ...realChoice, requestId: 'req-m2' });

    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });
});
