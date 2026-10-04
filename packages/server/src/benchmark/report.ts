import { readFileSync } from 'node:fs';
import type { BenchmarkResult } from './contracts';
import type { AiNetworkAttempt } from '../ai/client';

export interface VariantReport {
  variantId: string;
  role: string;
  mode: string;
  trials: number;
  scored: number;
  acceptable: number;
  acceptableRate: number | null;
  rawValidityRate: number;
  schemaValidityRate: number;
  knownCostUsd: number;
  costCoverage: number;
  p95EndToEndMs: number;
  failures: number;
  networkAttempts: number;
  unknownCostAttempts: number;
}

export function readResultsJsonl(path: string): BenchmarkResult[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BenchmarkResult);
}

export function readAttemptsJsonl(path: string): AiNetworkAttempt[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AiNetworkAttempt);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

export function buildReport(
  results: readonly BenchmarkResult[],
  attempts: readonly AiNetworkAttempt[] = [],
): VariantReport[] {
  const groups = new Map<string, BenchmarkResult[]>();
  for (const result of results) {
    const key = `${result.variantId}\u0000${result.role}\u0000${result.mode}`;
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const scored = group.filter((result) => result.score.labelStatus === 'scored');
    const attributedAttempts = attempts.filter(
      (attempt) =>
        attempt.benchmark?.variantId === first.variantId &&
        attempt.benchmark.role === first.role &&
        attempt.benchmark.mode === first.mode,
    );
    const groupAttempts =
      attributedAttempts.length > 0
        ? attributedAttempts
        : groups.size === 1 && attempts.every((attempt) => attempt.benchmark === undefined)
          ? [...attempts]
          : [];
    const useAttempts = groupAttempts.length > 0;
    const knownCost = group.filter((result) => result.costSource !== 'unknown');
    const knownAttempts = groupAttempts.filter((attempt) => attempt.usage.costSource !== 'unknown');
    return {
      variantId: first.variantId,
      role: first.role,
      mode: first.mode,
      trials: group.length,
      scored: scored.length,
      acceptable: scored.filter((result) => result.score.acceptable === true).length,
      acceptableRate:
        scored.length === 0
          ? null
          : scored.filter((result) => result.score.acceptable === true).length / scored.length,
      rawValidityRate: group.filter((result) => result.rawJsonValidity).length / group.length,
      schemaValidityRate: group.filter((result) => result.schemaValidity).length / group.length,
      knownCostUsd: useAttempts
        ? groupAttempts.reduce((sum, attempt) => sum + (attempt.usage.costUsd ?? 0), 0)
        : group.reduce((sum, result) => sum + (result.costUsd ?? 0), 0),
      costCoverage: useAttempts
        ? knownAttempts.length / groupAttempts.length
        : knownCost.length / group.length,
      p95EndToEndMs: percentile(
        group.map((result) => result.endToEndMs),
        0.95,
      ),
      failures: group.filter((result) => result.failure !== undefined).length,
      networkAttempts: useAttempts ? groupAttempts.length : 0,
      unknownCostAttempts: useAttempts ? groupAttempts.length - knownAttempts.length : 0,
    };
  });
}
