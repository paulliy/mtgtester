import { describe, expect, it } from 'vitest';
import type { AiNetworkAttempt } from '../ai/client';
import type { BenchmarkResult } from './contracts';
import { buildReport } from './report';

function result(variantId: string, runId: string): BenchmarkResult {
  return {
    schemaVersion: 1,
    runId,
    variantId,
    caseId: 'case-1',
    trial: 1,
    role: 'tactician',
    mode: 'raw',
    source: 'model',
    rawJsonValidity: true,
    schemaValidity: true,
    recoverySuccess: false,
    menuValidation: true,
    engineAcceptance: 'not_checked',
    score: { labelStatus: 'scored', acceptable: true, value: 1, metrics: {} },
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.100Z',
    endToEndMs: 100,
    costSource: 'reported',
  };
}

function attempt(
  variantId: string,
  runId: string,
  attemptIndex: number,
  costUsd?: number,
): AiNetworkAttempt {
  return {
    schemaVersion: 1,
    logicalRequestId: `${runId}-request`,
    attemptIndex,
    requestedModel: 'model',
    status: 'accepted',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.010Z',
    durationMs: 10,
    messages: [],
    effectiveConfig: {},
    usage: {
      ...(costUsd === undefined ? {} : { costUsd }),
      promptTokenSource: 'reported',
      responseTokenSource: 'reported',
      costSource: costUsd === undefined ? 'unknown' : 'reported',
    },
    benchmark: {
      runId,
      variantId,
      caseId: 'case-1',
      trial: 1,
      role: 'tactician',
      mode: 'raw',
    },
  };
}

describe('benchmark report attempt accounting', () => {
  it('attributes physical attempts across combined variant runs', () => {
    const reports = buildReport(
      [result('baseline', 'run-a'), result('candidate', 'run-b')],
      [
        attempt('baseline', 'run-a', 0, 0.1),
        attempt('candidate', 'run-b', 0),
        attempt('candidate', 'run-b', 1, 0.2),
      ],
    );
    expect(reports.find((item) => item.variantId === 'baseline')).toMatchObject({
      networkAttempts: 1,
      knownCostUsd: 0.1,
      costCoverage: 1,
      unknownCostAttempts: 0,
    });
    expect(reports.find((item) => item.variantId === 'candidate')).toMatchObject({
      networkAttempts: 2,
      knownCostUsd: 0.2,
      costCoverage: 0.5,
      unknownCostAttempts: 1,
    });
  });
});
