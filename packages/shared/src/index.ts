/**
 * `@mtg/shared` — the single source of truth for types (and a few runtime enum tuples)
 * shared across the engine, server, and web app. No logic lives here.
 *
 * `verbatimModuleSyntax` is on, so runtime values and types are re-exported separately.
 */

// --- Runtime values (enum tuples) ---
export { ALL_COLORS } from './mana';
export { turnPositionLabel } from './turn-labels';
export {
  PHASES,
  STEPS,
  ZONES,
  DECISION_TYPES,
  LOSS_REASONS,
  COMMANDER_DAMAGE_LETHAL,
} from './enums';
export { PERMANENT_STATUSES } from './objects';
export { COMMANDER_LEGALITIES } from './cards';
export { DECK_SOURCE_TYPES, VALIDATION_CODES } from './decks';
export {
  SERVER_TO_CLIENT_TYPES,
  CLIENT_TO_SERVER_TYPES,
  DEAL_DRAFT_MAX_CHARS,
  LOOKAHEAD_TURNS,
  PLAYER_IDLE_GRACE_MS,
  PLAYER_SEAT_IDS,
  isClientToServerMessage,
  isPlayerSeatId,
} from './protocol';
export { ATTACKS_TARGET, NO_ATTACK_TARGET, NO_BLOCK_TARGET } from './engine';
export { parseStrictJson, STRICT_JSON_MAX_DEPTH } from './json';
export { assertNever } from './assert-never';

// --- LegalAction.data key registry (ADR 0032) ---
export {
  ACTION_DATA_KEYS,
  ACTION_DATA_VALUE_TYPES,
  ACTION_DATA_CONSUMERS,
} from './action-data-keys';
export type {
  ActionDataKeyInfo,
  ActionDataValueType,
  ActionDataConsumer,
} from './action-data-keys';

// --- Strict inbound JSON (duplicate-key rejection ahead of the native parse) ---
export type { StrictJsonFailure, StrictJsonResult } from './json';

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
export type { PlayerState, GameState, GameResult, GameEndReason } from './state';
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
  PlannedSourceReference,
  PlanPrecondition,
  TurnStrategy,
  BotSteering,
  LegalAction,
  ActionInteraction,
  TargetSlot,
  TargetChoice,
  DecisionPresentation,
  ActionPresentation,
  ActionSubject,
  PresentedCard,
  PresentedSource,
  AttackDeclarationSubject,
  AttackDeclarationPresentation,
  BlockDeclarationSubject,
  BlockDeclarationPresentation,
  CombatViolation,
  CombatRejection,
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
  BoardGroup,
  SpectatorCommander,
  SpectatorStackObject,
  SpectatorLogLine,
  AiAnnotation,
  AiReflection,
  ReflectionMoment,
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
  StartGameMode,
  SeatControllerKind,
  SeatControllers,
  PlaybackMode,
  SeatSource,
  SeatSummary,
  SetupPreview,
  SetupPreviewSeat,
  SavedDeckOption,
  HaltKind,
  GameStartedPayload,
  CardTestScenarioMetadata,
  StateSnapshotPayload,
  EventBatchPayload,
  CueTarget,
  PresentationCue,
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
  GameReflectionsPayload,
  ErrorPayload,
  StartGamePayload,
  StartCardTestScenarioPayload,
  ClientCapabilities,
  JumpToTurnPayload,
  SetPlaybackModePayload,
  ResolveHeldDecisionPayload,
  SetDebugFlagsPayload,
  SubmitPlayerActionPayload,
  YieldPlayerAbilityPayload,
  ResumePlayerAbilityPayload,
  ResumeGamePayload,
  ProposeDealPayload,
  AnswerDealPayload,
  DraftDealPayload,
  DealOutcomeNotice,
  DiplomacyStatePayload,
  DealDraftPayload,
} from './protocol';

// --- Table diplomacy (ADR 0035) ---
export type {
  Deal,
  DealObligation,
  DealObligationKind,
  DealStatus,
  DealTerms,
  DiplomacySeatState,
  NegotiationSlot,
  OfferRefusal,
  TableMessage,
  TableMessageKind,
  TableTalkLine,
  ThreatReason,
  TrustSummary,
} from './diplomacy';

// --- Copy game report ---
export type {
  GameReport,
  GameReportBuild,
  GameReportCardData,
  GameReportDecklist,
  GameReportDeckSource,
  GameReportSeat,
} from './report';

export { BATCH_GAME_STATUSES, BATCH_STATUSES } from './batch';
export type {
  BatchAggregate,
  BatchFailure,
  BatchGameStatus,
  BatchGameSummary,
  BatchProgress,
  BatchResults,
  BatchScenarioProgress,
  BatchScenarioSpec,
  BatchSeatResult,
  BatchSpec,
  BatchStatus,
} from './batch';

// --- Table protocol (ADR 0031, plan M3) ---
export {
  PROTOCOL_VERSION,
  TABLE_CLIENT_TO_SERVER_TYPES,
  TABLE_SERVER_TO_CLIENT_TYPES,
  TABLE_MAX_DECKLIST_CHARS,
  TABLE_MAX_TOKEN_CHARS,
  TABLE_MAX_RAW_NAME_CHARS,
  parseTableClientMessage,
  parseTableClientFrame,
} from './table-protocol';
export type {
  ClaimIdPayload,
  ClaimPendingPayload,
  ClockStatePayload,
  DeckProblemsPayload,
  EmptyPayload,
  HostAuthPayload,
  HostKickPayload,
  HostSeatController,
  HostSetSeatPayload,
  JoinTablePayload,
  ProtocolMismatchPayload,
  ReplayTurnPayload,
  ReplayTurnStatePayload,
  RequestSeatPayload,
  ResumeSeatPayload,
  SeatGrantedPayload,
  SeatStatusPayload,
  SeatTakenOverPayload,
  TableCapabilities,
  TableClientMessageOf,
  TableClientToServerMessage,
  TableClientToServerType,
  TableClockMode,
  TableClosedPayload,
  TableClosedReason,
  TableDeckProblem,
  TableDeckProblemCode,
  TableEnding,
  TableParseFailure,
  TableParseResult,
  TablePendingClaimView,
  TablePhase,
  TableSeatController,
  TableSeatView,
  TableServerMessageOf,
  TableServerToClientMessage,
  TableServerToClientType,
  TableResultsDeck,
  TableResultsPayload,
  TableStatePayload,
  TableYouView,
} from './table-protocol';
