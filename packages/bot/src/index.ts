/**
 * A heuristic, non-LLM bot opponent (ADR 0023). Deliberately its own package: not
 * `packages/server/src/ai/` (the LLM path) and not `ai/heuristics.ts` (a cost-skipping shortcut
 * for dominated decisions, a different job). Depends only on `@mtg/shared`.
 */
export { evaluate, decide } from './evaluate';
export type { ScoredAction, EvaluateOptions } from './evaluate';
export { passesVeto, totalLifeCost, totalSacrificeCount, totalDiscardCount } from './veto';
export { WEIGHTS } from './weights';
export { Rng } from './rng';
export { HeuristicDecisionProvider } from './provider';
export type { DecisionProviderLike } from './provider';
