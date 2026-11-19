/** Immutable component identities recorded by benchmark manifests and result rows. */
export const AI_VERSIONS = Object.freeze({
  prompt: 'strategist-tactician-split-v2',
  tacticianPrimer: 'decision-shaped-tactician-primer-v3',
  strategistPrimer: 'strategist-primer-v3',
  context: 'modular-context-v3',
  publicMemory: 'public-memory-v1',
  stateFeatures: 'state-features-v1',
  contextBudget: 'context-budget-v1',
  cardSummary: 'effect-preserving-summary-v1',
  planLifecycle: 'plan-lifecycle-v1',
  replay: 'fresh-engine-replay-v1',
  counterfactual: 'bounded-counterfactual-v1',
  promptCache: 'stable-prefix-v2',
  /** Bot-led strategist delta prompts (hill-climb S6), used only when `strategistDeltaEnabled`. */
  strategistDelta: 'strategist-delta-v1',
  parser: 'decision-parser-v1',
  validator: 'legal-menu-validator-v1',
  evaluator: 'snapshot-evaluator-v1',
  router: 'interpretable-router-v1',
  policyRegistry: 'policy-registry-v1',
  promotion: 'release-policy-v1',
  league: 'controlled-league-v1',
  policy: 'provider-pipeline-v1',
  strategyProfile: 'strategy-profile-v1',
} as const);

export type AiVersionKey = keyof typeof AI_VERSIONS;
