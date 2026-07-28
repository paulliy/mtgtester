/**
 * `@mtg/shared` — the single source of truth for types (and a few runtime enum tuples)
 * shared across the engine, server, and web app. No logic lives here.
 *
 * `verbatimModuleSyntax` is on, so runtime values and types are re-exported separately.
 */

// --- Runtime values (enum tuples) ---
export { ALL_COLORS } from './mana';
export { PHASES, STEPS, ZONES, DECISION_TYPES, LOSS_REASONS } from './enums';
export { PERMANENT_STATUSES } from './objects';
export { COMMANDER_LEGALITIES } from './cards';
export { DECK_SOURCE_TYPES, VALIDATION_CODES } from './decks';
export {
  SERVER_TO_CLIENT_TYPES,
  CLIENT_TO_SERVER_TYPES,
  LOOKAHEAD_TURNS,
  isClientToServerMessage,
} from './protocol';

// --- Identifier types ---
export type { PlayerId, ObjectId, OracleId, DeckId, DeckSnapshotId, GameId } from './ids';

// --- Mana ---
export type { Color, ManaCostString, ManaPool } from './mana';

// --- Enumerations ---
export type { Phase, Step, Zone, DecisionType, LossReason } from './enums';

// --- Game objects & state ---
export type {
  GameObject,
  PermanentState,
  PermanentStatus,
  StackObject,
  StackObjectKind,
} from './objects';
export type { PlayerState, GameState, GameResult } from './state';
export type { ContinuousEffect } from './effects';
export type { GameEvent } from './events';

// --- Card data (deck pipeline + engine card cache) ---
export type { OracleCard, CommanderLegality } from './cards';

// --- Deck pipeline (import → resolve → validate → snapshot) ---
export type {
  DeckSourceType,
  ParsedDeckEntry,
  ParsedDeck,
  ResolvedDeckEntry,
  ResolvedDeck,
  ResolutionResult,
  ValidationCode,
  ValidationIssue,
  ValidationResult,
  DeckCardEntry,
  DeckSnapshot,
} from './decks';

// --- Engine decision contract ---
export type {
  EngineStep,
  DecisionRequest,
  DecisionResponse,
  PlannedAction,
  TurnStrategy,
  LegalAction,
  ActionInteraction,
  TargetSlot,
  TargetChoice,
} from './engine';

// --- Player-visible projection (anti-cheat boundary) ---
export type {
  PlayerView,
  OpponentView,
  CommanderView,
  CardView,
  PermanentView,
  StackObjectView,
} from './view';

// --- Human-player browser projection (Phase 6 anti-cheat boundary) ---
export type { PlayerBoardState, PlayerBoardSeat } from './player';

// --- Spectator projection (brief §10.2) — the inverse of PlayerView: the human watches ---
export type {
  SpectatorState,
  SpectatorSeat,
  SpectatorCard,
  SpectatorPermanent,
  SpectatorCommander,
  SpectatorStackObject,
  SpectatorLogLine,
  CommanderDamageEntry,
} from './spectator';

// --- WebSocket protocol ---
export type {
  ServerToClientMessage,
  ClientToServerMessage,
  ServerToClientType,
  ClientToServerType,
  ServerMessageOf,
  ClientMessageOf,
  ProviderKind,
  GameMode,
  SeatControllerKind,
  PlaybackMode,
  SeatSource,
  SeatSummary,
  HaltKind,
  GameStartedPayload,
  StateSnapshotPayload,
  EventBatchPayload,
  DecisionPendingPayload,
  ComputeHaltedPayload,
  ApiWaitingPayload,
  DebugFlags,
  DebugEventsPayload,
  IgnoredPlayerAbility,
  PlayerStateSnapshotPayload,
  PlayerActionRequiredPayload,
  SessionPausedPayload,
  ReplayUnlockedPayload,
  GameOverPayload,
  ErrorPayload,
  StartGamePayload,
  JumpToTurnPayload,
  SetPlaybackModePayload,
  ResolveHeldDecisionPayload,
  SetDebugFlagsPayload,
  SubmitPlayerActionPayload,
  YieldPlayerAbilityPayload,
  ResumePlayerAbilityPayload,
  ResumeGamePayload,
} from './protocol';
