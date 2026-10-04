import type { AiNetworkAttempt } from '../ai/client';

export interface CacheExperimentReport {
  schemaVersion: 1;
  status: 'measured' | 'insufficient' | 'unknown';
  prefixHash: string;
  requestedModel: string;
  requests: number;
  firstCallColdStatus: 'unverified';
  observedReadRequests: number;
  observedWriteRequests: number;
  unknownCacheStatusRequests: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptTokens: number;
  observedReadTokenRate: number | null;
  firstLatencyMs: number | null;
  warmP50LatencyMs: number | null;
  knownCostUsd: number;
  costCoverage: number;
  independentSamples: boolean;
  limitations: string[];
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? null
  );
}

/** Reports only provider-observed cache fields. Prefix stability alone is never called a hit. */
export function buildCacheExperimentReports(
  attempts: readonly AiNetworkAttempt[],
): CacheExperimentReport[] {
  const groups = new Map<string, AiNetworkAttempt[]>();
  for (const attempt of attempts) {
    const prefix = attempt.promptCache?.prefixHash;
    if (prefix === undefined) continue;
    const key = `${prefix}\u0000${attempt.requestedModel}`;
    const group = groups.get(key) ?? [];
    group.push(attempt);
    groups.set(key, group);
  }
  return [...groups.values()].map((unordered) => {
    const group = [...unordered].sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt),
    );
    const first = group[0]!;
    const observed = group.filter(
      (item) => item.usage.cacheStatus !== undefined && item.usage.cacheStatus !== 'unknown',
    );
    const knownCost = group.filter((item) => item.usage.costSource !== 'unknown');
    const cacheReadTokens = group.reduce((sum, item) => sum + (item.usage.cacheReadTokens ?? 0), 0);
    const cacheWriteTokens = group.reduce(
      (sum, item) => sum + (item.usage.cacheWriteTokens ?? 0),
      0,
    );
    const promptTokens = group.reduce((sum, item) => sum + (item.usage.promptTokens ?? 0), 0);
    return {
      schemaVersion: 1,
      status: group.length < 2 ? 'insufficient' : observed.length === 0 ? 'unknown' : 'measured',
      prefixHash: first.promptCache!.prefixHash,
      requestedModel: first.requestedModel,
      requests: group.length,
      firstCallColdStatus: 'unverified',
      observedReadRequests: group.filter((item) => item.usage.cacheStatus === 'observed_hit')
        .length,
      observedWriteRequests: group.filter((item) => (item.usage.cacheWriteTokens ?? 0) > 0).length,
      unknownCacheStatusRequests: group.length - observed.length,
      cacheReadTokens,
      cacheWriteTokens,
      promptTokens,
      observedReadTokenRate: promptTokens === 0 ? null : cacheReadTokens / promptTokens,
      firstLatencyMs: first.durationMs,
      warmP50LatencyMs: percentile(
        group.slice(1).map((item) => item.durationMs),
        0.5,
      ),
      knownCostUsd: group.reduce((sum, item) => sum + (item.usage.costUsd ?? 0), 0),
      costCoverage: knownCost.length / group.length,
      independentSamples: group.every(
        (item) => item.promptCache?.completeResponseCacheAllowed === false,
      ),
      limitations: [
        'first-call provider cache state is unverified unless the provider supplied a control',
        'observed savings require provider-reported cache token fields',
        'response caching is excluded from independent quality samples',
      ],
    };
  });
}
