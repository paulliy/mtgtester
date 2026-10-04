import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import { AiCallLogger, localCallMeta, type SqliteDb } from './logger';
import type { CallMeta } from './client';

describe('AiCallLogger', () => {
  it('logs call metadata to SQLite statements', () => {
    const mockRun = vi.fn();
    const mockDb: SqliteDb = {
      query: vi.fn().mockReturnValue({ run: mockRun, all: vi.fn() }),
    };

    const logger = new AiCallLogger(mockDb, 'g100');

    const req: DecisionRequest = {
      requestId: 'r1',
      gameId: 'g100',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      decisionType: 'priority',
      prompt: 'Prompt',
      legalActions: [],
    };

    const res: DecisionResponse = { requestId: 'r1', actionId: 0 };
    const meta: CallMeta = {
      model: 'gemini-3.5-flash-lite',
      promptTokens: 500,
      responseTokens: 20,
      latencyMs: 150,
      wasRetry: false,
      wasFallback: false,
      rawResponse: '{"actionId":0}',
    };

    logger.log(req, { response: res, meta }, false, false);

    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ai_calls'));
    expect(mockRun).toHaveBeenCalledWith(
      'g100',
      1,
      1,
      'gemini-3.5-flash-lite',
      500,
      20,
      expect.any(String),
      expect.any(String),
      0,
      0,
      150,
      null,
      'primary',
      // The request's turn, denormalised onto the row so rebuilding ADR 0022 annotations does
      // not have to parse every stored request payload.
      1,
    );
  });

  it('counts locally-answered decisions as skipped calls', () => {
    const logger = new AiCallLogger(null, 'g101');

    const req: DecisionRequest = {
      requestId: 'r1',
      gameId: 'g101',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'beginning',
      step: 'upkeep',
      decisionType: 'priority',
      prompt: 'Prompt',
      legalActions: [],
    };
    const local = { response: { requestId: 'r1', actionId: 0 }, meta: localCallMeta() };

    logger.log(req, local, false, false, 'heuristic');
    logger.log(req, local, false, false, 'cache');
    logger.log(req, local, false, false, 'primary');

    expect(logger.summary()).toMatchObject({
      totalDecisions: 3,
      totalCalls: 1,
      skippedCalls: 2,
    });
    expect(logger.sourceFor('r1')).toBe('primary');
  });

  it('retains a local resolution source for transcript reporting', () => {
    const logger = new AiCallLogger(null, 'g101');
    const req: DecisionRequest = {
      requestId: 'r-local',
      gameId: 'g101',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'beginning',
      step: 'upkeep',
      decisionType: 'priority',
      prompt: 'Prompt',
      legalActions: [],
    };
    logger.log(
      req,
      { response: { requestId: 'r-local', actionId: 0 }, meta: localCallMeta() },
      false,
      false,
      'heuristic',
    );

    expect(logger.sourceFor('r-local')).toBe('heuristic');
  });

  it('retains token, latency, retry, and fallback metrics without SQLite', () => {
    const logger = new AiCallLogger(null, 'g102');
    const req: DecisionRequest = {
      requestId: 'r1',
      gameId: 'g102',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      decisionType: 'priority',
      prompt: 'Prompt',
      legalActions: [],
    };
    logger.log(
      req,
      {
        response: { requestId: 'r1', actionId: 0 },
        meta: {
          model: 'm1',
          promptTokens: 120,
          responseTokens: 12,
          latencyMs: 90,
          wasRetry: true,
          wasFallback: true,
          rawResponse: '{}',
        },
      },
      true,
      true,
      'fallback',
    );

    expect(logger.summary()).toMatchObject({
      totalCalls: 1,
      retries: 1,
      fallbacks: 1,
      totalPromptTokens: 120,
      totalResponseTokens: 12,
      avgLatencyMs: 90,
    });
  });

  it('reports strategist and tactician latency separately', () => {
    const logger = new AiCallLogger(null, 'g103');
    const req: DecisionRequest = {
      requestId: 'r1',
      gameId: 'g103',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      decisionType: 'general',
      prompt: 'Prompt',
      legalActions: [],
    };
    const meta = (latencyMs: number): CallMeta => ({
      model: 'm1',
      promptTokens: 10,
      responseTokens: 10,
      latencyMs,
      wasRetry: false,
      wasFallback: false,
      rawResponse: '{}',
    });

    logger.log(
      req,
      { response: { requestId: 'r1', actionId: 0 }, meta: meta(20000) },
      false,
      false,
      'strategist',
    );
    logger.log(
      req,
      { response: { requestId: 'r2', actionId: 0 }, meta: meta(3000) },
      false,
      false,
      'primary',
    );
    logger.log(
      req,
      { response: { requestId: 'r3', actionId: 0 }, meta: meta(5000) },
      false,
      false,
      'primary',
    );

    expect(logger.summary()).toMatchObject({
      avgStrategistLatencyMs: 20000,
      avgTacticianLatencyMs: 4000,
    });
  });

  it('aggregates physical attempt cost and exposes unknown accounting coverage', () => {
    const logger = new AiCallLogger(null, 'g-attempts');
    const base = {
      schemaVersion: 1 as const,
      logicalRequestId: 'r1',
      requestedModel: 'm1',
      status: 'accepted' as const,
      startedAt: '2026-09-20T00:00:00.000Z',
      endedAt: '2026-09-20T00:00:00.100Z',
      durationMs: 100,
      messages: [],
      effectiveConfig: {},
    };
    logger.recordAttempt({
      ...base,
      attemptIndex: 0,
      usage: {
        costUsd: 0.002,
        promptTokenSource: 'reported',
        responseTokenSource: 'reported',
        costSource: 'reported',
      },
    });
    logger.recordAttempt({
      ...base,
      attemptIndex: 1,
      status: 'transport_error',
      usage: {
        promptTokenSource: 'unknown',
        responseTokenSource: 'unknown',
        costSource: 'unknown',
      },
    });

    expect(logger.summary()).toMatchObject({
      networkAttempts: 2,
      unknownCostAttempts: 1,
      costAccountingCoverage: 0.5,
      totalCostUsd: 0.002,
    });
  });
});

describe('AiCallLogger Jev traces', () => {
  it('retains policy evidence and marks an active selection engine-accepted at its anchor', () => {
    const logger = new AiCallLogger(null, 'g-jev');
    logger.recordJevTrace({
      schemaVersion: 1,
      logicalRequestId: 'r-jev',
      recordedAt: '2026-09-22T00:00:00.000Z',
      mode: 'active',
      classification: {
        shape: 'action_only',
        jevSupported: true,
        reason: 'supported_action_only',
        actionCount: 2,
        targetSlotCount: 0,
      },
      outcome: 'accepted',
      validationResult: 'valid',
      networkAttempted: true,
      confidence: 0.9,
      topTwoMargin: 0.8,
      probabilities: { action_0: 0.1, action_1: 0.9 },
      selectedActionId: 1,
      engineAcceptance: 'not_checked',
    });

    logger.recordAnchor('r-jev', 42);
    expect(logger.capturedJevTraces()).toEqual([
      expect.objectContaining({
        logicalRequestId: 'r-jev',
        engineAcceptance: 'accepted',
      }),
    ]);
  });
});

/**
 * Post-game reflection is a real billed call, but it is not a decision (ADR 0022 §8). Both halves
 * matter: counting it as skipped would understate spend, and counting it in `avgLatencyMs` would
 * make the headline "average decision latency" jump after every game for a call that happened
 * once the game was already over.
 */
describe('AiCallLogger — the reflection source', () => {
  const request: DecisionRequest = {
    requestId: 'reflect-1',
    gameId: 'g200',
    turn: 12,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'ending',
    step: null,
    decisionType: 'general',
    prompt: 'Review the game you just played.',
    legalActions: [],
  };

  function call(latencyMs: number): { response: DecisionResponse; meta: CallMeta } {
    return {
      response: { requestId: request.requestId, actionId: 0 },
      meta: {
        model: 'test/model',
        promptTokens: 100,
        responseTokens: 50,
        latencyMs,
        wasRetry: false,
        wasFallback: false,
        rawResponse: '{}',
      },
    };
  }

  it('counts as a billed call rather than a skipped one', () => {
    const logger = new AiCallLogger(null, 'g200');
    logger.log(request, call(20_000), false, false, 'reflection');

    const summary = logger.summary();
    expect(summary.totalCalls).toBe(1);
    expect(summary.skippedCalls).toBe(0);
  });

  it('is excluded from average decision latency', () => {
    const logger = new AiCallLogger(null, 'g200');
    logger.log({ ...request, requestId: 'd1' }, call(100), false, false, 'primary');
    logger.log({ ...request, requestId: 'd2' }, call(300), false, false, 'primary');
    // A 20s retrospective would drag a 200ms average to nearly 7 seconds if it counted.
    logger.log(request, call(20_000), false, false, 'reflection');

    expect(logger.summary().avgLatencyMs).toBe(200);
  });
});
