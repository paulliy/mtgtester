import type { BenchmarkRole } from '../benchmark/contracts';

export type PolicyHandler = 'deterministic' | 'economical' | 'stronger' | 'unsupported';
export type PolicyEvidenceStatus = 'eligible' | 'unmeasured' | 'rejected';

export interface PolicyCandidate {
  id: string;
  handler: PolicyHandler;
  provider: string;
  model: string;
  roles: BenchmarkRole[];
  supportedDecisionTypes: string[] | '*';
  reasoning: { enabled: boolean; effort: string };
  limits: { contextTokens?: number; outputTokens?: number };
  evidenceStatus: PolicyEvidenceStatus;
  measuredAt?: string;
  reliability?: { trials: number; usableRate: number };
  latencyMs?: { p50: number; p95: number };
  cost?: { unit: string; knownCoverage: number; meanUsd?: number };
  implementationRevision?: string;
}

export interface PolicyRegistry {
  schemaVersion: 1;
  registryId: string;
  measuredAt: string | null;
  candidates: PolicyCandidate[];
}

/** Versioned rollout registry used when a caller does not inject a benchmark-selected registry. */
export const DEFAULT_POLICY_REGISTRY: PolicyRegistry = {
  schemaVersion: 1,
  registryId: 'jev-shadow-registry-v1',
  measuredAt: null,
  candidates: [
    {
      id: 'deterministic-forced-choice-v1',
      handler: 'deterministic',
      provider: 'local',
      model: 'engine-forced-choice',
      roles: ['tactician'],
      supportedDecisionTypes: '*',
      reasoning: { enabled: false, effort: 'none' },
      limits: {},
      evidenceStatus: 'eligible',
      implementationRevision: 'interpretable-router-v1',
    },
    {
      id: 'jev-action-selector-1.13-v1',
      handler: 'economical',
      provider: 'openrouter',
      model: 'typesafe/jev-1.13',
      roles: ['tactician'],
      supportedDecisionTypes: [
        'priority',
        'mulligan',
        'optionalTrigger',
        'commanderReplacement',
        'legendRule',
        'general',
      ],
      reasoning: { enabled: false, effort: 'none' },
      limits: { contextTokens: 32_768 },
      evidenceStatus: 'unmeasured',
      implementationRevision: 'jev-action-selector-v1',
    },
    {
      id: 'configured-stronger-shadow-v1',
      handler: 'stronger',
      provider: 'configured-at-runtime',
      model: 'configured-strategist-chain',
      roles: ['tactician', 'strategist'],
      supportedDecisionTypes: '*',
      reasoning: { enabled: true, effort: 'configured' },
      limits: {},
      evidenceStatus: 'unmeasured',
    },
  ],
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePolicyRegistry(value: unknown): PolicyRegistry {
  if (!record(value) || value['schemaVersion'] !== 1) {
    throw new Error('policy registry schemaVersion must be 1');
  }
  if (typeof value['registryId'] !== 'string' || !Array.isArray(value['candidates'])) {
    throw new Error('policy registry requires registryId and candidates');
  }
  const ids = new Set<string>();
  for (const raw of value['candidates']) {
    if (!record(raw) || typeof raw['id'] !== 'string') throw new Error('candidate id is required');
    if (ids.has(raw['id'])) throw new Error(`duplicate policy candidate ${raw['id']}`);
    ids.add(raw['id']);
    if (
      !['deterministic', 'economical', 'stronger', 'unsupported'].includes(String(raw['handler']))
    ) {
      throw new Error(`candidate ${raw['id']} has an invalid handler`);
    }
    if (!['eligible', 'unmeasured', 'rejected'].includes(String(raw['evidenceStatus']))) {
      throw new Error(`candidate ${raw['id']} has an invalid evidenceStatus`);
    }
    if (typeof raw['provider'] !== 'string' || typeof raw['model'] !== 'string') {
      throw new Error(`candidate ${raw['id']} requires provider and model`);
    }
    if (
      !Array.isArray(raw['roles']) ||
      !raw['roles'].every((role) => role === 'tactician' || role === 'strategist')
    ) {
      throw new Error(`candidate ${raw['id']} has invalid roles`);
    }
    if (
      raw['supportedDecisionTypes'] !== '*' &&
      (!Array.isArray(raw['supportedDecisionTypes']) ||
        !raw['supportedDecisionTypes'].every((type) => typeof type === 'string'))
    ) {
      throw new Error(`candidate ${raw['id']} has invalid supportedDecisionTypes`);
    }
  }
  return value as unknown as PolicyRegistry;
}

export function eligibleCandidate(
  registry: PolicyRegistry,
  handler: PolicyHandler,
  role: BenchmarkRole,
  decisionType: string,
): PolicyCandidate | null {
  return (
    registry.candidates.find(
      (candidate) =>
        candidate.handler === handler &&
        candidate.evidenceStatus === 'eligible' &&
        candidate.roles.includes(role) &&
        (candidate.supportedDecisionTypes === '*' ||
          candidate.supportedDecisionTypes.includes(decisionType)),
    ) ?? null
  );
}
