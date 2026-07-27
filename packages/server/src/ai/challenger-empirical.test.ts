import { describe, expect, it } from 'vitest';
import type { DecisionRequest, DecisionResponse, TargetChoice, PlayerView } from '@mtg/shared';
import type { Engine } from '@mtg/engine';
import { TurnPlanManager } from './turn-plan';
import { validateResponse } from './validate';
import { OpenAiDecisionProvider } from './provider';
import { OpenAiCompatibleClient } from './client';
import { classifyError } from './retry';
import { AiResponseValidationError, HttpError } from './errors';
import { digestDecision, DecisionCache } from './decision-cache';
import { tryHeuristic } from './heuristics';
import type { AiConfig } from './config';

function makeMockEngine(p1View: PlayerView, p2View: PlayerView) {
  const debugLogs: Array<{ cat: string; msg: string; data?: unknown }> = [];
  return {
    view: (player: string) => (player === 'P1' ? p1View : p2View),
    addDebug: (cat: string, msg: string, data?: unknown) => {
      debugLogs.push({ cat, msg, data });
    },
    debugLogs,
  } as unknown as Engine;
}

function makeMockClient(responseMap: Map<string, DecisionResponse | string | Error>) {
  let callCount = 0;
  const calls: Array<{ prompt: unknown; request: DecisionRequest }> = [];
  return {
    get callCount() {
      return callCount;
    },
    calls,
    activeModel: 'test-model',
    requestDecision: async (prompt: unknown, request: DecisionRequest) => {
      callCount++;
      calls.push({ prompt, request });
      const mockResult = responseMap.get(request.requestId) ?? responseMap.get('default');
      if (mockResult instanceof Error) {
        throw mockResult;
      }
      if (mockResult) {
        return {
          response: mockResult as DecisionResponse,
          meta: {
            model: 'test-model',
            promptTokens: 10,
            responseTokens: 10,
            latencyMs: 5,
            wasRetry: false,
            wasFallback: false,
            rawResponse: JSON.stringify(mockResult),
          },
        };
      }
      throw new Error(`No mock result for request ${request.requestId}`);
    },
  } as unknown as OpenAiCompatibleClient;
}

function makeMockQueue() {
  return {
    enqueue: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
}

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

function makePlayerView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    seat: 'P1',
    life: 20,
    hand: [{ id: 'c1', name: 'Giant Growth', typeLine: 'Instant' }],
    deck: [],
    graveyard: [],
    availableMana: { G: 1 },
    commanders: [],
    battlefield: [],
    stack: [],
    recentLog: [],
    opponents: [{ seat: 'P2', life: 20, handSize: 5, librarySize: 40, graveyard: [], commanders: [], poisonCounters: 0, commanderDamageDealtToYou: 0 }],
    ...overrides,
  };
}

describe('Adversarial Stress Tests — Task 1: TurnPlanManager Stale Queue Behavior', () => {
  it('Task 1.1: Multi-provider setups isolate TurnPlanManager instances, causing P1 to execute stale pre-planned actions after opponent P2 intervenes', async () => {
    const p1View = makePlayerView({ seat: 'P1' });
    const p2View = makePlayerView({ seat: 'P2' });
    const engine = makeMockEngine(p1View, p2View);
    const queue = makeMockQueue();
    const config = {
      baseUrl: 'http://localhost',
      models: ['test-model'],
      heuristicsEnabled: true,
      decisionCacheEnabled: true,
      maxRetries: 1,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    } as unknown as AiConfig;

    const responseMapP1 = new Map<string, DecisionResponse>();
    responseMapP1.set('req-p1-1', {
      requestId: 'req-p1-1',
      actionId: 1, // Play Forest
      plannedActions: [
        { type: 'pass' }, // Pre-plan to pass priority after playing land
      ],
    });

    const responseMapP2 = new Map<string, DecisionResponse>();
    responseMapP2.set('req-p2-1', {
      requestId: 'req-p2-1',
      actionId: 2, // Opponent P2 casts Giant Growth (non-pass action!)
    });

    // In production, each seat has its OWN OpenAiDecisionProvider instance!
    const providerP1 = new OpenAiDecisionProvider(makeMockClient(responseMapP1), queue, engine, config);
    const providerP2 = new OpenAiDecisionProvider(makeMockClient(responseMapP2), queue, engine, config);

    // Step 1: P1 makes a decision and pre-plans `pass`
    const reqP1_1 = makeRequest({ requestId: 'req-p1-1', decidingPlayer: 'P1', activePlayer: 'P1' });
    const resP1_1 = await providerP1.decide(reqP1_1);
    expect(resP1_1.actionId).toBe(1);

    // Step 2: Priority passes to P2. P2 takes a real non-pass action (casts instant)
    const reqP2_1 = makeRequest({
      requestId: 'req-p2-1',
      decidingPlayer: 'P2',
      activePlayer: 'P1',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 2, type: 'castSpell', description: 'Cast Giant Growth' },
      ],
    });
    const resP2_1 = await providerP2.decide(reqP2_1);
    expect(resP2_1.actionId).toBe(2); // P2 cast Giant Growth

    // Step 3: Priority returns to P1. P1's provider should re-evaluate because P2 intervened.
    // BUT because providerP1 and providerP2 do NOT share TurnPlanManager, providerP1's turnPlan queue STILL HAS `[{ type: 'pass' }]`!
    const reqP1_2 = makeRequest({
      requestId: 'req-p1-2',
      decidingPlayer: 'P1',
      activePlayer: 'P1',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 2, type: 'castSpell', description: 'Cast Counterspell' },
      ],
    });

    const clientP1CallsBefore = (providerP1 as unknown as { client: { callCount: number } }).client.callCount;
    const resP1_2 = await providerP1.decide(reqP1_2);
    const clientP1CallsAfter = (providerP1 as unknown as { client: { callCount: number } }).client.callCount;

    // EMPIRICAL VERIFICATION OF BUG:
    // P1 executed the pre-planned `pass` action from its local turnPlan queue WITHOUT consulting the model!
    expect(clientP1CallsAfter).toBe(clientP1CallsBefore); // 0 network calls were made!
    expect(resP1_2.note).toContain('TurnPlan: pre-planned action executed');
    expect(resP1_2.actionId).toBe(0); // Passed priority blindly despite P2 casting Giant Growth!
  });

  it('Task 1.2: TurnPlanManager fails to track phase/step transitions, executing planned actions across phase boundaries', () => {
    const manager = new TurnPlanManager();
    const reqMain = makeRequest({
      requestId: 'req-1',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
    });
    const resMain: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1,
      plannedActions: [{ type: 'pass' }],
    };
    manager.recordDecision(reqMain, resMain, 'primary');

    // Phase transitions to Combat -> declareAttackers! Turn number is STILL 1.
    const reqCombat = makeRequest({
      requestId: 'req-2',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'combat',
      step: 'declareAttackers',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }],
    });

    // EMPIRICAL VERIFICATION OF BUG:
    // tryExecutePlan STILL executes the planned action from Main Phase inside Combat declareAttackers!
    const planned = manager.tryExecutePlan(reqCombat);
    expect(planned).not.toBeNull();
    expect(planned?.actionId).toBe(0);
  });
});

describe('Adversarial Stress Tests — Task 2: validateResponse with invalid plannedActions', () => {
  it('Task 2.1: validateResponse ignores malformed plannedActions at creation time', () => {
    const request = makeRequest({ requestId: 'req-1' });
    const responseWithInvalidPlans: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1,
      plannedActions: [
        // Non-string fields that will bypass checks or crash string methods in findMatchingAction
        { type: 123 as unknown as string, name: 456 as unknown as string },
        // Malformed targets object
        { type: 'castSpell', targets: 'not-an-array' as unknown as TargetChoice[] },
      ],
    };

    // EMPIRICAL VERIFICATION OF BUG:
    // validateResponse returns null (valid!), ignoring the invalid plannedActions payload!
    const error = validateResponse(responseWithInvalidPlans, request);
    expect(error).toBeNull();
  });

  it('Task 2.2: Numeric planned.name bypasses name filter in findMatchingAction because (number).length is undefined', () => {
    const manager = new TurnPlanManager();
    const req1 = makeRequest({ requestId: 'req-1' });
    const res1: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1,
      plannedActions: [
        { type: 'castSpell', name: 12345 as unknown as string }, // Number instead of string
      ],
    };

    manager.recordDecision(req1, res1, 'primary');

    const req2 = makeRequest({
      requestId: 'req-2',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 2, type: 'castSpell', description: 'Cast Counterspell' }, // Spell on menu is Counterspell, NOT 12345!
      ],
    });

    // EMPIRICAL VERIFICATION OF BUG:
    // `planned.name.length` is undefined. `undefined > 0` is false.
    // So findMatchingAction BYPASSES the name check and matches Counterspell!
    const planned = manager.tryExecutePlan(req2);
    expect(planned).not.toBeNull();
    expect(planned?.actionId).toBe(2);
  });

  it('Task 2.3: Non-string planned.name with length > 0 (e.g. array) causes runtime TypeError in findMatchingAction', () => {
    const manager = new TurnPlanManager();
    const req1 = makeRequest({ requestId: 'req-1' });
    const res1: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1,
      plannedActions: [
        { type: 'castSpell', name: ['non', 'string'] as unknown as string }, // Array with length > 0
      ],
    };

    manager.recordDecision(req1, res1, 'primary');

    const req2 = makeRequest({
      requestId: 'req-2',
      legalActions: [{ id: 2, type: 'castSpell', description: 'Cast Grizzly Bears' }],
    });

    // EMPIRICAL VERIFICATION OF BUG:
    // tryExecutePlan calls planned.name.toLowerCase(), which throws uncaught TypeError!
    expect(() => manager.tryExecutePlan(req2)).toThrow(TypeError);
  });

  it('Task 2.4: Malformed targets in plannedActions cause runtime TypeError in findMatchingAction', () => {
    const manager = new TurnPlanManager();
    const req1 = makeRequest({ requestId: 'req-1' });
    const res1: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1,
      plannedActions: [
        { type: 'castSpell', name: 'Grizzly Bears', targets: 'invalid-string' as unknown as TargetChoice[] },
      ],
    };

    manager.recordDecision(req1, res1, 'primary');

    const req2 = makeRequest({
      requestId: 'req-2',
      legalActions: [
        {
          id: 2,
          type: 'castSpell',
          description: 'Cast Grizzly Bears',
          targets: [{ slot: 0, options: ['target-1', 'target-2'] }],
        },
      ],
    });

    // EMPIRICAL VERIFICATION OF BUG:
    // tryExecutePlan calls planned.targets.find(...), throwing uncaught TypeError because targets is a string!
    expect(() => manager.tryExecutePlan(req2)).toThrow(TypeError);
  });
});

describe('Adversarial Stress Tests — Task 3: Non-empty Stack Resolution Scenarios', () => {
  it('Task 3.1: tryDeferInstant heuristic is completely disabled when view.stack.length > 0', () => {
    const request = makeRequest({
      decidingPlayer: 'P2',
      activePlayer: 'P1',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 1, type: 'castSpell', description: 'Cast Giant Growth', data: { instantSpeed: true } },
      ],
    });

    // Case A: Empty stack
    const emptyStackView = makePlayerView({ seat: 'P2', stack: [] });
    const heuristicEmpty = tryHeuristic(request, emptyStackView);
    expect(heuristicEmpty).not.toBeNull();
    expect(heuristicEmpty?.actionId).toBe(0); // Safely deferred!

    // Case B: Non-empty stack (a spell is on the stack)
    const nonEmpStackView = makePlayerView({
      seat: 'P2',
      stack: [{ id: 'spell-1', controller: 'P1', description: 'Lightning Bolt', targets: [] }],
    });
    const heuristicNonEmpty = tryHeuristic(request, nonEmpStackView);

    // EMPIRICAL VERIFICATION:
    // Heuristic returns null when stack > 0, forcing every priority pass to query model or cache!
    expect(heuristicNonEmpty).toBeNull();
  });

  it('Task 3.2: Measure decision request volume & cache invalidation across stack additions and resolutions', () => {
    const cache = new DecisionCache();
    const reqP2 = makeRequest({
      requestId: 'req-p2-1',
      decidingPlayer: 'P2',
      activePlayer: 'P1',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 1, type: 'castSpell', description: 'Cast Giant Growth', data: { instantSpeed: true } },
      ],
    });

    // Stack State 1: P1 casts Spell A
    const viewState1 = makePlayerView({
      seat: 'P2',
      stack: [{ id: 'spell-1', controller: 'P1', description: 'Spell A', targets: [] }],
    });
    const hash1 = digestDecision(reqP2, viewState1);

    // Stack State 2: P2 responds with Instant B -> Stack has 2 spells
    const viewState2 = makePlayerView({
      seat: 'P2',
      stack: [
        { id: 'spell-1', controller: 'P1', description: 'Spell A', targets: [] },
        { id: 'spell-2', controller: 'P2', description: 'Instant B', targets: [] },
      ],
    });
    const hash2 = digestDecision(reqP2, viewState2);

    // Stack State 3: Instant B resolves -> Stack goes back to 1 spell (Spell A)
    // Note: P2 spent mana and used card B!
    const viewState3 = makePlayerView({
      seat: 'P2',
      hand: [], // Card B left hand
      graveyard: [{ id: 'c1', name: 'Giant Growth', typeLine: 'Instant' }],
      availableMana: {}, // Mana spent
      stack: [{ id: 'spell-1', controller: 'P1', description: 'Spell A', targets: [] }],
    });
    const hash3 = digestDecision(reqP2, viewState3);

    // EMPIRICAL VERIFICATION:
    // Stack changes produce 3 distinct digest hashes, completely invalidating cache hits across stack transitions!
    expect(hash1).not.toEqual(hash2);
    expect(hash1).not.toEqual(hash3);
    expect(hash2).not.toEqual(hash3);

    // Prime cache with state 1 response
    cache.set(reqP2, viewState1, { requestId: 'req-p2-1', actionId: 0 });

    // Query cache in state 2: MISS
    expect(cache.get(reqP2, viewState2)).toBeNull();
    // Query cache in state 3: MISS (because hand/mana/graveyard changed)
    expect(cache.get(reqP2, viewState3)).toBeNull();
  });
});

describe('Adversarial Stress Tests — Task 4: parseJsonResponse & classifyError Handling', () => {
  it('Task 4.1: classifyError classifies HTML 502/504 HttpError as retryable', () => {
    const error502 = new HttpError(502, '<html><body>502 Bad Gateway</body></html>');
    const category = classifyError(error502);
    expect(category).toBe('retryable');
  });

  it('Task 4.2: HttpError in provider.decide bypasses Step 2 Corrective Retry and jumps straight to safestFallback', async () => {
    const p1View = makePlayerView({ seat: 'P1' });
    const engine = makeMockEngine(p1View, p1View);
    const queue = makeMockQueue();
    const config = {
      baseUrl: 'http://localhost',
      models: ['test-model'],
      heuristicsEnabled: false,
      decisionCacheEnabled: false,
      maxRetries: 0, // No network retry
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    } as unknown as AiConfig;

    const mockClient = {
      activeModel: 'test-model',
      requestDecision: async () => {
        throw new HttpError(504, '<html><body>504 Gateway Timeout</body></html>');
      },
    } as unknown as OpenAiCompatibleClient;

    const provider = new OpenAiDecisionProvider(mockClient, queue, engine, config);
    const req = makeRequest({ requestId: 'req-http-fail' });

    // EMPIRICAL VERIFICATION OF BUG:
    // Provider catches HttpError and returns safestFallback WITHOUT invoking Step 2 (Corrective Retry prompt)!
    const response = await provider.decide(req);
    expect(response.actionId).toBe(0); // Pass (safest fallback)
    expect(response.note).toContain('Fallback');
  });

  it('Task 4.3: Truncated JSON is a retryable generation failure, and reaches the Step 2 Corrective Retry instead of dropping straight to a fallback', async () => {
    const truncatedContent = '{"requestId": "req-1", "actionId": 1, "note": "truncated text without closing brace';

    let fetchCalls = 0;
    const mockFetch = async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: truncatedContent } }],
        }),
      };
    };

    const client = new OpenAiCompatibleClient(
      {
        baseUrl: 'http://localhost',
        models: ['test-model'],
        maxRetries: 3,
        baseBackoffMs: 1,
        maxBackoffMs: 5,
      } as unknown as AiConfig,
      mockFetch as unknown as typeof fetch,
    );

    // 1. The client still surfaces AiResponseValidationError once it gives up...
    let thrownError: unknown;
    try {
      await client.requestDecision({ messages: [] } as unknown as Parameters<typeof client.requestDecision>[0], makeRequest());
    } catch (e) {
      thrownError = e;
    }

    expect(thrownError).toBeInstanceOf(AiResponseValidationError);

    // 2. ...but not on the first sample: an unreadable answer is a stochastic failure, so it is
    //    resampled on a budget of its own (1 primary + GENERATION_RETRY_CAP) rather than
    //    spending the whole decision on one unlucky generation.
    expect(classifyError(thrownError)).toBe('retryable_generation');
    expect(fetchCalls).toBe(3);

    // 3. At the provider, the unreadable response now feeds §7.7 step 1 — the model is shown
    //    its own bad output and the menu again — instead of jumping to the safest legal action.
    const p1View = makePlayerView({ seat: 'P1' });
    const engine = makeMockEngine(p1View, p1View);
    const queue = makeMockQueue();
    const config = {
      baseUrl: 'http://localhost',
      models: ['test-model'],
      heuristicsEnabled: false,
      decisionCacheEnabled: false,
      maxRetries: 3,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    } as unknown as AiConfig;

    let networkAttempts = 0;
    const mockClientRecovering = {
      activeModel: 'test-model',
      requestDecision: async (_prompt: unknown, request: DecisionRequest) => {
        networkAttempts++;
        if (networkAttempts === 1) {
          throw new AiResponseValidationError('Invalid JSON format: ...', truncatedContent);
        }
        return {
          response: { requestId: request.requestId, actionId: 2 },
          meta: {
            model: 'test-model',
            promptTokens: 10,
            responseTokens: 10,
            latencyMs: 5,
            wasRetry: false,
            wasFallback: false,
            rawResponse: '{"actionId":2}',
          },
        };
      },
    } as unknown as OpenAiCompatibleClient;

    const provider = new OpenAiDecisionProvider(mockClientRecovering, queue, engine, config);
    const res = await provider.decide(makeRequest({ requestId: 'req-trunc' }));

    expect(networkAttempts).toBe(2); // Corrective retry was attempted.
    expect(res.actionId).toBe(2); // ...and the model's real answer was used, not a fallback.
    expect(res.note ?? '').not.toContain('Fallback');
  });

  it('Task 4.4: Markdown preamble with JSON-like braces before a code fence still parses', async () => {
    const preambleWithBraces = `I considered choices {option A} and {option B}.
\`\`\`json
{
  "requestId": "req-1",
  "actionId": 1
}
\`\`\``;

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: preambleWithBraces } }],
      }),
    });

    const client = new OpenAiCompatibleClient(
      { baseUrl: 'http://localhost', models: ['test-model'] } as unknown as AiConfig,
      mockFetch as unknown as typeof fetch,
    );

    // The greedy `/\{[\s\S]*\}/` this replaces ran from the first brace in the preamble to the
    // last brace in the fence, so one chatty sentence made a perfectly good answer unreadable.
    const { response } = await client.requestDecision(
      { messages: [] } as unknown as Parameters<typeof client.requestDecision>[0],
      makeRequest(),
    );

    expect(response.actionId).toBe(1);
  });
});
