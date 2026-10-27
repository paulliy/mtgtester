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
export { resolveCombatSnapshot } from './combat-snapshot';
export type {
  CombatSnapshot,
  CombatOutcome,
  SnapshotAttacker,
  SnapshotCreature,
} from './combat-snapshot';
export {
  searchBlockAssignment,
  searchDamageSplit,
  staticBlockChoices,
  staticDamageSplit,
  parseBlockSubjects,
} from './combat-search';
export type {
  BlockAssignment,
  BlockSubjectData,
  CombatSearchOptions,
  DamageSplitSpec,
} from './combat-search';
export { HeuristicDecisionProvider } from './provider';
export {
  DiplomacyTable,
  describeMessage,
  describeObligation,
  estimateTable,
  withDiplomacy,
} from './diplomacy';
export type {
  ActiveObligation,
  BreachReason,
  DiplomacyPlay,
  DiplomacyStats,
  DiplomacyTableOptions,
  SeatEstimate,
  SeatName,
  TableEstimate,
} from './diplomacy';
export type { DecisionProviderLike, HeuristicProviderOptions } from './provider';
