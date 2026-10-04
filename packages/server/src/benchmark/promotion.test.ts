import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluatePromotion, parseReleasePolicy } from './promotion';

const policy = JSON.parse(
  readFileSync(resolve('benchmarks/release-policy.json'), 'utf8'),
) as Record<string, unknown>;
const clone = (): Record<string, unknown> => structuredClone(policy);

describe('release policy contract', () => {
  it('accepts the checked-in proposed policy', () => {
    expect(parseReleasePolicy(clone()).status).toBe('proposed');
  });

  it.each([
    ['typo', 'value'],
    ['quality.typo', 1],
    ['reliability.typo', 1],
    ['latency.typo', 1],
    ['cost.typo', 1],
    ['sampleExpansion.typo', 1],
  ])('rejects unknown policy key %s', (path, invalid) => {
    const candidate = clone();
    const keys = path.split('.');
    let target = candidate;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys.at(-1)!] = invalid;
    expect(() => parseReleasePolicy(candidate)).toThrow(/unknown|unexpected|key/i);
  });

  it.each([
    'schemaVersion',
    'status',
    'quality',
    'reliability',
    'latency',
    'cost',
    'sampleExpansion',
    'criticalCaseIds',
    'verdicts',
    'quality.maximumAcceptableRateDropPoints',
    'quality.newConfirmedCriticalBlundersAllowed',
    'reliability.maximumFailureRate',
    'latency.maximumComparableP95IncreasePercent',
    'cost.unit',
    'cost.proposedCeilingUsd',
    'cost.requireCompleteAccountingForUnqualifiedPass',
    'cost.spendCapUsd',
    'sampleExpansion.onInconclusive',
    'sampleExpansion.maximumMultiplier',
  ])('rejects missing required policy key %s', (path) => {
    const candidate = clone();
    const keys = path.split('.');
    let target = candidate;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    delete target[keys.at(-1)!];
    expect(() => parseReleasePolicy(candidate)).toThrow();
  });

  it.each([
    ['schemaVersion', 2],
    ['status', 'approved'],
    ['quality.maximumAcceptableRateDropPoints', -1],
    ['quality.newConfirmedCriticalBlundersAllowed', 0.5],
    ['reliability.maximumFailureRate', 2],
    ['latency.maximumComparableP95IncreasePercent', Infinity],
    ['cost.unit', 'other'],
    ['cost.proposedCeilingUsd', -1],
    ['cost.requireCompleteAccountingForUnqualifiedPass', 'true'],
    ['cost.spendCapUsd', NaN],
    ['sampleExpansion.onInconclusive', 1],
    ['sampleExpansion.maximumMultiplier', -1],
    ['criticalCaseIds', [3]],
    ['verdicts', ['pass', 'fail']],
  ])('rejects invalid %s', (path, invalid) => {
    const candidate = clone();
    const keys = path.split('.');
    let target = candidate;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys.at(-1)!] = invalid;
    expect(() => parseReleasePolicy(candidate)).toThrow();
  });

  it.each([
    'schemaVersion',
    'status',
    'quality.maximumAcceptableRateDropPoints',
    'quality.newConfirmedCriticalBlundersAllowed',
    'reliability.maximumFailureRate',
    'latency.maximumComparableP95IncreasePercent',
    'cost.unit',
    'cost.proposedCeilingUsd',
    'cost.requireCompleteAccountingForUnqualifiedPass',
    'cost.spendCapUsd',
    'sampleExpansion.onInconclusive',
    'sampleExpansion.maximumMultiplier',
    'criticalCaseIds',
    'verdicts',
  ])('rejects missing %s', (path) => {
    const candidate = clone();
    const keys = path.split('.');
    let target = candidate;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    delete target[keys.at(-1)!];
    expect(() => parseReleasePolicy(candidate)).toThrow();
  });

  it.each([
    'quality.maximumAcceptableRateDropPoints',
    'quality.newConfirmedCriticalBlundersAllowed',
    'reliability.maximumFailureRate',
    'latency.maximumComparableP95IncreasePercent',
    'cost.proposedCeilingUsd',
    'cost.spendCapUsd',
    'sampleExpansion.maximumMultiplier',
  ])('rejects wrong-type, nonfinite, and negative %s', (path) => {
    for (const invalid of ['1', Infinity, NaN, -1]) {
      const candidate = clone();
      const keys = path.split('.');
      let target = candidate;
      for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
      target[keys.at(-1)!] = invalid;
      expect(() => parseReleasePolicy(candidate)).toThrow();
    }
  });

  it('throws on malformed policy at evaluation time', () => {
    const malformed = clone();
    delete (malformed['quality'] as Record<string, unknown>)['maximumAcceptableRateDropPoints'];
    expect(() => evaluatePromotion(malformed as never, {} as never)).toThrow(/policy/i);
  });
});
