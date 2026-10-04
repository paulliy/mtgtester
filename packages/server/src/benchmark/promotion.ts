import type { VariantReport } from './report';

export interface ReleasePolicy {
  schemaVersion: 1;
  status: 'proposed' | 'validated';
  quality: {
    maximumAcceptableRateDropPoints: number;
    newConfirmedCriticalBlundersAllowed: number;
  };
  reliability: { maximumFailureRate: number };
  latency: { maximumComparableP95IncreasePercent: number };
  cost: {
    unit: 'ai-seat-active-turn';
    proposedCeilingUsd: number;
    requireCompleteAccountingForUnqualifiedPass: boolean;
    spendCapUsd: number;
  };
  sampleExpansion: { onInconclusive: boolean; maximumMultiplier: number };
  criticalCaseIds: string[];
  verdicts: ['pass', 'fail', 'inconclusive'];
}

export interface PromotionEvidence {
  baseline: VariantReport;
  candidate: VariantReport;
  newConfirmedCriticalBlunders: number;
  comparableWorkload: boolean;
  deterministicGatesPassed: boolean;
  hiddenInformationLeaks: number;
  engineAcceptedIllegalActions: number;
  candidateActiveTurnCostUsd?: number;
}

export interface PromotionVerdict {
  verdict: 'pass' | 'fail' | 'inconclusive';
  policyStatus: ReleasePolicy['status'];
  reasons: string[];
  metrics: {
    acceptableRateDropPoints: number | null;
    candidateFailureRate: number;
    p95LatencyIncreasePercent: number | null;
    costCoverage: number;
    activeTurnCostUsd: number | null;
  };
  defaultMayChange: boolean;
  sampleExpansionAllowed: boolean;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validReport(value: unknown): value is VariantReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const report = value as Partial<VariantReport>;
  return (
    finiteNonNegative(report.trials) &&
    Number.isInteger(report.trials) &&
    finiteNonNegative(report.failures) &&
    Number.isInteger(report.failures) &&
    report.failures <= report.trials &&
    (report.acceptableRate === null ||
      (typeof report.acceptableRate === 'number' &&
        Number.isFinite(report.acceptableRate) &&
        report.acceptableRate >= 0 &&
        report.acceptableRate <= 1)) &&
    finiteNonNegative(report.p95EndToEndMs) &&
    typeof report.costCoverage === 'number' &&
    Number.isFinite(report.costCoverage) &&
    report.costCoverage >= 0 &&
    report.costCoverage <= 1
  );
}

export function parseReleasePolicy(value: unknown): ReleasePolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('release policy must be an object');
  }
  const policy = value as Record<string, unknown>;
  const assertKeys = (
    part: Record<string, unknown>,
    label: string,
    allowed: readonly string[],
  ): void => {
    const keys = new Set(allowed);
    for (const key of Object.keys(part)) {
      if (!keys.has(key)) throw new Error(`release policy ${label} has unknown key: ${key}`);
    }
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(part, key)) {
        throw new Error(`release policy ${label} is missing required key: ${key}`);
      }
    }
  };
  assertKeys(policy, 'root', [
    'schemaVersion',
    'status',
    'quality',
    'reliability',
    'latency',
    'cost',
    'sampleExpansion',
    'criticalCaseIds',
    'verdicts',
  ]);
  const object = (name: string): Record<string, unknown> => {
    const part = policy[name];
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      throw new Error(`release policy ${name} must be an object`);
    }
    return part as Record<string, unknown>;
  };
  const number = (part: Record<string, unknown>, field: string, integer = false): void => {
    const value = part[field];
    if (!finiteNonNegative(value) || (integer && !Number.isInteger(value))) {
      throw new Error(`release policy ${field} must be finite and non-negative`);
    }
  };
  const boolean = (part: Record<string, unknown>, field: string): void => {
    if (typeof part[field] !== 'boolean')
      throw new Error(`release policy ${field} must be boolean`);
  };
  if (policy['schemaVersion'] !== 1) throw new Error('release policy schemaVersion must be 1');
  if (policy['status'] !== 'proposed' && policy['status'] !== 'validated') {
    throw new Error('release policy status must be proposed or validated');
  }
  const quality = object('quality');
  assertKeys(quality, 'quality', [
    'maximumAcceptableRateDropPoints',
    'newConfirmedCriticalBlundersAllowed',
  ]);
  number(quality, 'maximumAcceptableRateDropPoints');
  number(quality, 'newConfirmedCriticalBlundersAllowed', true);
  const reliability = object('reliability');
  assertKeys(reliability, 'reliability', ['maximumFailureRate']);
  number(reliability, 'maximumFailureRate');
  if ((reliability['maximumFailureRate'] as number) > 1)
    throw new Error('release policy maximumFailureRate must be at most 1');
  const latency = object('latency');
  assertKeys(latency, 'latency', ['maximumComparableP95IncreasePercent']);
  number(latency, 'maximumComparableP95IncreasePercent');
  const cost = object('cost');
  assertKeys(cost, 'cost', [
    'unit',
    'proposedCeilingUsd',
    'requireCompleteAccountingForUnqualifiedPass',
    'spendCapUsd',
  ]);
  if (cost['unit'] !== 'ai-seat-active-turn')
    throw new Error('release policy cost unit is invalid');
  number(cost, 'proposedCeilingUsd');
  number(cost, 'spendCapUsd');
  boolean(cost, 'requireCompleteAccountingForUnqualifiedPass');
  const expansion = object('sampleExpansion');
  assertKeys(expansion, 'sampleExpansion', ['onInconclusive', 'maximumMultiplier']);
  boolean(expansion, 'onInconclusive');
  number(expansion, 'maximumMultiplier');
  if (
    !Array.isArray(policy['criticalCaseIds']) ||
    !policy['criticalCaseIds'].every((id) => typeof id === 'string' && id.length > 0)
  ) {
    throw new Error('release policy criticalCaseIds must be strings');
  }
  if (
    !Array.isArray(policy['verdicts']) ||
    policy['verdicts'].length !== 3 ||
    policy['verdicts'][0] !== 'pass' ||
    policy['verdicts'][1] !== 'fail' ||
    policy['verdicts'][2] !== 'inconclusive'
  ) {
    throw new Error('release policy verdicts are invalid');
  }
  return value as unknown as ReleasePolicy;
}

export function evaluatePromotion(
  policy: ReleasePolicy,
  evidence: PromotionEvidence,
): PromotionVerdict {
  parseReleasePolicy(policy);
  if (
    !validReport(evidence?.baseline) ||
    !validReport(evidence?.candidate) ||
    typeof evidence?.comparableWorkload !== 'boolean' ||
    typeof evidence?.deterministicGatesPassed !== 'boolean' ||
    !finiteNonNegative(evidence?.newConfirmedCriticalBlunders) ||
    !Number.isInteger(evidence.newConfirmedCriticalBlunders) ||
    !finiteNonNegative(evidence?.hiddenInformationLeaks) ||
    !Number.isInteger(evidence.hiddenInformationLeaks) ||
    !finiteNonNegative(evidence?.engineAcceptedIllegalActions) ||
    !Number.isInteger(evidence.engineAcceptedIllegalActions) ||
    (evidence.candidateActiveTurnCostUsd !== undefined &&
      !finiteNonNegative(evidence.candidateActiveTurnCostUsd))
  ) {
    throw new Error('promotion invariant evidence must be explicit and non-negative');
  }
  const reasons: string[] = [];
  const acceptableRateDropPoints =
    evidence.baseline.acceptableRate === null || evidence.candidate.acceptableRate === null
      ? null
      : (evidence.baseline.acceptableRate - evidence.candidate.acceptableRate) * 100;
  const p95LatencyIncreasePercent =
    evidence.baseline.p95EndToEndMs <= 0
      ? null
      : ((evidence.candidate.p95EndToEndMs - evidence.baseline.p95EndToEndMs) /
          evidence.baseline.p95EndToEndMs) *
        100;
  const candidateFailureRate =
    evidence.candidate.trials === 0 ? 1 : evidence.candidate.failures / evidence.candidate.trials;
  let fail = false;
  let inconclusive = false;

  if (!evidence.deterministicGatesPassed) {
    reasons.push('deterministic gates did not pass');
    fail = true;
  }
  if (evidence.hiddenInformationLeaks > 0 || evidence.engineAcceptedIllegalActions > 0) {
    reasons.push('hard privacy or engine-legality invariant failed');
    fail = true;
  }
  if (evidence.newConfirmedCriticalBlunders > policy.quality.newConfirmedCriticalBlundersAllowed) {
    reasons.push('new confirmed critical blunder exceeds policy');
    fail = true;
  }
  if (acceptableRateDropPoints === null) {
    reasons.push('quality evidence is unscored');
    inconclusive = true;
  } else if (acceptableRateDropPoints > policy.quality.maximumAcceptableRateDropPoints) {
    reasons.push('acceptable-or-better rate drop exceeds policy');
    fail = true;
  }
  if (candidateFailureRate > policy.reliability.maximumFailureRate) {
    reasons.push('candidate failure rate exceeds policy');
    fail = true;
  }
  if (!evidence.comparableWorkload || p95LatencyIncreasePercent === null) {
    reasons.push('latency workload is not comparable');
    inconclusive = true;
  } else if (p95LatencyIncreasePercent > policy.latency.maximumComparableP95IncreasePercent) {
    reasons.push('P95 user-visible latency increase exceeds policy');
    fail = true;
  }
  if (
    policy.cost.requireCompleteAccountingForUnqualifiedPass &&
    evidence.candidate.costCoverage < 1
  ) {
    reasons.push('cost accounting coverage is incomplete');
    inconclusive = true;
  }
  if (evidence.candidateActiveTurnCostUsd === undefined) {
    reasons.push('active-turn cost unit was not measured');
    inconclusive = true;
  } else if (evidence.candidateActiveTurnCostUsd > policy.cost.proposedCeilingUsd) {
    reasons.push('active-turn cost exceeds the proposed ceiling');
    fail = true;
  }
  if (policy.status !== 'validated') {
    reasons.push('release policy is still proposed, not validated');
    inconclusive = true;
  }
  const verdict = fail ? 'fail' : inconclusive ? 'inconclusive' : 'pass';
  return {
    verdict,
    policyStatus: policy.status,
    reasons,
    metrics: {
      acceptableRateDropPoints,
      candidateFailureRate,
      p95LatencyIncreasePercent,
      costCoverage: evidence.candidate.costCoverage,
      activeTurnCostUsd: evidence.candidateActiveTurnCostUsd ?? null,
    },
    defaultMayChange: verdict === 'pass' && policy.status === 'validated',
    sampleExpansionAllowed: verdict === 'inconclusive' && policy.sampleExpansion.onInconclusive,
  };
}
