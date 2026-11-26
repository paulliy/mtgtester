/**
 * The model-backed services a `MatchSession` uses: the OpenAI-compatible clients, the strategist,
 * reflections, deal drafting and the call logger. A session receives them as `ai` in its options
 * instead of importing `ai/` itself, so a session whose seats are all heuristic bots or people
 * (a table, or a game running in a browser) bundles none of that code or its dependencies.
 *
 * The server passes `sessionAi`. Environment reads happen here, not in the session, because a
 * browser has no `process.env`.
 */

import {
  AiCallLogger,
  condenseSeatLog,
  configForRole,
  createConfiguredJevPolicy,
  GameAiBudget,
  limitedClient,
  loadAiConfig,
  OpenAiCompatibleClient,
  OpenAiDecisionProvider,
  publishReflections,
  RequestQueue,
  readStrategistProposal,
  runReflection,
  seatDiplomacyContext,
  StrategyCoordinator,
  type AiAttemptObserver,
  type AiConfig,
  type JevComparisonObserver,
  type JevPolicyBinding,
  type JevTraceObserver,
} from '../ai';

export const sessionAi = {
  AiCallLogger,
  condenseSeatLog,
  configForRole,
  /** The JEV policy configured by this process's environment, if any. */
  createConfiguredJevPolicy: (
    config: AiConfig,
    observer?: AiAttemptObserver,
    traceObserver?: JevTraceObserver,
    comparisonObserver?: JevComparisonObserver,
  ): JevPolicyBinding | null =>
    createConfiguredJevPolicy(config, process.env, observer, traceObserver, comparisonObserver),
  /** The AI configuration from this process's environment. */
  loadAiConfig: () => loadAiConfig(process.env),
  /** A table game's spending cap and the client wrapper that enforces it (ADR 0055). */
  GameAiBudget,
  limitedClient,
  OpenAiCompatibleClient,
  OpenAiDecisionProvider,
  publishReflections,
  RequestQueue,
  readStrategistProposal,
  runReflection,
  seatDiplomacyContext,
  StrategyCoordinator,
};

export type SessionAi = typeof sessionAi;
