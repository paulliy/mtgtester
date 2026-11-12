/**
 * A heuristic, non-LLM bot opponent (ADR 0023). Deliberately its own package: not
 * `packages/server/src/ai/` (the LLM path) and not `ai/heuristics.ts` (a cost-skipping shortcut
 * for dominated decisions, a different job). Depends only on `@mtg/shared`.
 */
export { evaluate, decide, decideScored } from './evaluate';
export type { ScoredAction, ScoredDecision, EvaluateOptions } from './evaluate';
export { CARD_ROLES } from './card-knowledge';
export type {
  CardKnowledge,
  CardRole,
  CardTraits,
  StatBoost,
  TargetPolarity,
  WipeSelector,
} from './card-knowledge';
export { manaValueOfCost } from './policy';
export { BOT_POLICY_VERSION } from './version';
export { DEFAULT_POLICY_FIXES, POLICY_FIXES, parsePolicyFixes } from './fixes';
export type { PolicyFix } from './fixes';
export { passesVeto, totalLifeCost, totalSacrificeCount, totalDiscardCount } from './veto';
export { WEIGHTS } from './weights';
export { Rng } from './rng';
export type { RandomSource } from './rng';
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
  DIPLOMACY_STATE_VERSION,
  DiplomacyTable,
  Exploiter,
  MAX_CONCESSION_PER_DEAL,
  describeMessage,
  describeObligation,
  estimateTable,
  summarizeExploits,
  withDiplomacy,
  withDiplomacyAsync,
} from './diplomacy';
export type {
  ActiveObligation,
  BreachReason,
  DiplomacyPlay,
  DiplomacyState,
  DiplomacyStats,
  DiplomacyTableOptions,
  ExploitRecord,
  ExploitSummary,
  ExploitTactic,
  OfferOutcome,
  OfferTerms,
  SeatEstimate,
  SeatName,
  TableEstimate,
} from './diplomacy';
export type { DecisionProviderLike, HeuristicProviderOptions } from './provider';
