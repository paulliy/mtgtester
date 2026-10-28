/**
 * `@mtg/engine` — the deterministic, authoritative MTG Commander rules engine (brief §5).
 * Pure TypeScript: no I/O, no network, no framework, no knowledge that an AI exists. It
 * exposes decision points (`advance`) and receives decisions (`submit`).
 *
 * Phase 2: full turn structure, priority/APNAP, the stack, state-based actions, combat,
 * Commander rules, London mulligans, and legal-action generation — driven by scripted or
 * random decision providers. AI integration arrives in Phase 3 behind the same contract.
 */

export const ENGINE_VERSION = '0.2.0-phase2';

// The driver.
export { Engine } from './engine';
export type { EngineDriver, EngineOptions } from './engine';
export type { PreparedScenarioSpec } from './testing/prepared-scenario';
export { buildGuardedCandidateDefinition } from './testing/candidate-definition';
export {
  FABLED_PASSAGE_CANDIDATE,
  FABLED_PASSAGE_HANDLED_LINES,
} from './cards/overrides/queen-marchesa-queens-gambit';
export {
  MYRIAD_LANDSCAPE_CANDIDATE,
  MYRIAD_LANDSCAPE_HANDLED_LINES,
} from './cards/overrides/necron-dynasties';

// Game construction.
export { createGame } from './state/game';
export type {
  EnginePlayerConfig,
  GameConfig,
  GameContext,
  DebugEntry,
  EngineState,
} from './state/types';

// Card interpretation (the server will reuse this to pre-flight decks in Phase 3).
export { interpretCard } from './cards/interpret';
export type {
  CardDefinition,
  Ability,
  Effect,
  TargetSpec,
  TargetKind,
  KeywordAbility,
  TriggerSpec,
  TriggerSubject,
  TriggerWhen,
} from './cards/definition';
export { IMPLEMENTED_KEYWORDS } from './cards/definition';

// Errors.
export {
  EngineInvariantError,
  EngineUsageError,
  IllegalDecisionError,
  UnmodeledCardError,
} from './errors';

// Seeded PRNG (exposed for providers/tests; the engine owns its own instance).
export { Prng } from './rng/prng';

// The anti-cheat projection (brief §7.1).
export { buildPlayerView } from './view/view';

// The spectator projection and action log (brief §10.2 — Phase 4).
export {
  buildPlayerBoardState,
  buildSpectatorState,
  formatPlayerLog,
  formatSpectatorLine,
  formatSpectatorLog,
} from './view/spectator';

// Scripted/random decision providers and the completion driver (Phase 2 — brief §14.1).
export {
  RandomDecisionProvider,
  ScriptedDecisionProvider,
  choose,
  chooseFirst,
  runToCompletion,
  runToCompletionAsync,
} from './providers/providers';
export type { DecisionProvider, AsyncDecisionProvider, ScriptedStep } from './providers/providers';
