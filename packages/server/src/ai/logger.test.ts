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
      0,
      'primary',
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
});
