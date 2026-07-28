/**
 * WebSocket protocol between server and web client (brief §11). The server owns the engine
 * and the AI calls; the frontend is a view and receives pushed updates. Payloads are flat and
 * serializable — the frontend needs no engine code to interpret them.
 *
 * The message names are exactly §11's. Where Phase 4 needed to convey something the list did
 * not name, it rides on an existing payload rather than widening the set (ADR 0012): the
 * compute frontier travels on `eventBatch`/`stateSnapshot`, and AI call counters on
 * `apiWaiting`.
 */

import type { DecisionRequest, TargetChoice } from './engine';
import type { GameId, PlayerId } from './ids';
import type { GameResult } from './state';
import type { PlayerBoardState } from './player';
import type { SpectatorLogLine, SpectatorState } from './spectator';
import type { ValidationIssue } from './decks';

/** Server → client message types (brief §11). */
export const SERVER_TO_CLIENT_TYPES = [
  'gameStarted',
  'stateSnapshot',
  'eventBatch',
  'decisionPending',
  'computeHalted',
  'apiWaiting',
  'debugEvents',
  'playerStateSnapshot',
  'playerActionRequired',
  'sessionPaused',
  'replayUnlocked',
  'gameOver',
  'error',
] as const;
export type ServerToClientType = (typeof SERVER_TO_CLIENT_TYPES)[number];

/** Client → server message types (brief §11). */
export const CLIENT_TO_SERVER_TYPES = [
  'startGame',
  'jumpToTurn',
  'setPlaybackMode',
  'resolveHeldDecision',
  'abandonGame',
  'setDebugFlags',
  'submitPlayerAction',
  'yieldPlayerAbility',
  'resumePlayerAbility',
  'resumeGame',
] as const;
export type ClientToServerType = (typeof CLIENT_TO_SERVER_TYPES)[number];

// ── Shared vocabulary ───────────────────────────────────────────────────────────────────────

/**
 * Who answers decisions. `random` is free and deterministic given the seed; `ai` spends real
 * budget on every non-local decision (ADR 0010, ADR 0011). See ADR 0012 §4.
 */
export type ProviderKind = 'random' | 'ai';
export type GameMode = 'spectator' | 'singlePlayer';
export type SeatControllerKind = ProviderKind | 'human';

/** Live-ish compute-ahead vs. the user stepping it forward (brief §10.1). */
export type PlaybackMode = 'live' | 'manual';

/**
 * Turns the engine may compute beyond the viewer's position (brief §10.1). Shared because both
 * ends need it: the server enforces it, and the UI explains the pause it causes. It lived only
 * on the server with the web app carrying its own hardcoded 5.
 */
export const LOOKAHEAD_TURNS = 5;

/** How the four seats get their decks. */
export type SeatSource =
  | { kind: 'pool'; seed?: string }
  | { kind: 'url'; url: string; archetypeTag?: string }
  | { kind: 'plaintext'; text: string; name?: string; archetypeTag?: string };

/** Why the runner stopped computing (brief §10.1 hold-and-wait). */
export type HaltKind =
  | 'unmodeledCard'
  | 'invalidAiResponse'
  | 'engineError'
  | 'draw'
  | 'aiBudgetExhausted'
  | 'turnCap';

export interface SeatSummary {
  seat: PlayerId;
  deckId: string;
  label: string;
  commanderNames: string[];
  colorIdentity: string[];
  archetypeTag: string;
}

// ── Server → client ─────────────────────────────────────────────────────────────────────────

/** A game has begun; carries the seating and the seed (brief §4 — the seed is displayed). */
export interface GameStartedPayload {
  gameId: GameId;
  seed: string;
  seats: SeatSummary[];
  providerKind: ProviderKind;
  gameMode?: GameMode;
  controllers?: Array<{ seat: PlayerId; kind: SeatControllerKind }>;
  humanSeat?: PlayerId;
  /** Opaque reconnect credential. Present only for single-player games. */
  sessionToken?: string;
  /** Current bot presentation pace, retained across a player-session reconnect. */
  paceMs?: number;
  startedAt: string;
}

/** The board at one turn. Sent on start, on jump, and whenever the viewer's position moves. */
export interface StateSnapshotPayload {
  turn: number;
  state: SpectatorState;
  /** The furthest turn computed so far — the scrubber's upper bound (brief §10.1). */
  frontierTurn: number;
  /** True when this snapshot is the live edge rather than a replayed past turn. */
  atFrontier: boolean;
  /**
   * The action-log `sequence` this board is the result of, when the client asked to seek to one
   * and the server had that exact board. Null for a plain turn snapshot — the client uses it to
   * decide which log line (if any) it may legitimately highlight as "you are here".
   */
  sequence?: number | null;
}

/** Newly computed log lines, plus the advancing frontier they came from. */
export interface EventBatchPayload {
  gameId: GameId;
  lines: SpectatorLogLine[];
  frontierTurn: number;
  /** Turns for which a snapshot exists, so the scrubber knows where it may seek. */
  snapshotTurns: number[];
}

/**
 * The AI failed twice on a decision the user is currently watching (brief §7.7 step 2). The
 * user has `timeoutMs` to pick, after which the server applies the safest legal action.
 */
export interface DecisionPendingPayload {
  request: DecisionRequest;
  /** The raw thing the model returned, for the user to see what went wrong. */
  invalidResponse: string;
  timeoutMs: number;
}

/** Compute stopped and will not continue until the user resolves it (brief §10.1). */
export interface ComputeHaltedPayload {
  gameId: GameId;
  kind: HaltKind;
  reason: string;
  turn: number;
  /** The offending card, when the halt was an unmodeled one (brief §6.3). */
  cardName?: string;
}

/** Why playback paused (brief §7.5 — queue depth and wait state must be visible). */
export interface ApiWaitingPayload {
  queueDepth: number;
  /** How long the current request has been waiting, in ms. */
  waitingMs: number;
  reason: 'rateLimit' | 'inFlight' | 'backoff';
  /** Running per-game cost counters (brief §7.4). */
  calls: number;
  skippedCalls: number;
  promptTokens: number;
  responseTokens: number;
}

/** Runtime display controls for the Phase 5 debug suite. Persistence is never disabled. */
export interface DebugFlags {
  showAIRequests: boolean;
  showAIResponses: boolean;
  showLegalActions: boolean;
  showSBAChecks: boolean;
  showPriorityPasses: boolean;
  showTokenUsage: boolean;
  verboseEngine: boolean;
}

export interface DebugEventsPayload {
  gameId: GameId;
  entries: Array<{ turn: number; category: string; message: string; data?: Record<string, unknown> }>;
}

/** Current hidden-information-safe board for the active human player. */
export interface PlayerStateSnapshotPayload {
  gameId: GameId;
  state: PlayerBoardState;
  revision: number;
  connected: boolean;
  ignoredAbilities: IgnoredPlayerAbility[];
}

/** A non-rules UI preference: hide an optional activated ability until the player re-enables it. */
export interface IgnoredPlayerAbility {
  key: string;
  label: string;
}

/** A real, untimed engine decision that only the selected human seat may answer. */
export interface PlayerActionRequiredPayload {
  request: DecisionRequest;
  state: PlayerBoardState;
  revision: number;
  ignoredAbilities: IgnoredPlayerAbility[];
}

export interface SessionPausedPayload {
  gameId: GameId;
  reason: 'playerDisconnected' | 'waitingForPlayer';
}

/** Full-information replay becomes available only after a single-player game is over. */
export interface ReplayUnlockedPayload {
  state: SpectatorState;
  lines: SpectatorLogLine[];
  snapshotTurns: number[];
  frontierTurn: number;
}

export interface GameOverPayload {
  result: GameResult;
  /** Finishing positions, 1st through 4th. */
  standings: Array<{ seat: PlayerId; position: number; lossReason: string | null }>;
}

export interface ErrorPayload {
  message: string;
  /** Per-deck validation problems, when the error came from deck setup (brief §8.3). */
  deckIssues?: Array<{ seat: PlayerId; issues: ValidationIssue[] }>;
  /** Cards the engine cannot model, when setup pre-flight rejected a deck (ADR 0009/0012). */
  unmodeledCards?: Array<{ seat: PlayerId; cards: string[] }>;
}

export type ServerToClientMessage =
  | { type: 'gameStarted'; payload: GameStartedPayload }
  | { type: 'stateSnapshot'; payload: StateSnapshotPayload }
  | { type: 'eventBatch'; payload: EventBatchPayload }
  | { type: 'decisionPending'; payload: DecisionPendingPayload }
  | { type: 'computeHalted'; payload: ComputeHaltedPayload }
  | { type: 'apiWaiting'; payload: ApiWaitingPayload }
  | { type: 'debugEvents'; payload: DebugEventsPayload }
  | { type: 'playerStateSnapshot'; payload: PlayerStateSnapshotPayload }
  | { type: 'playerActionRequired'; payload: PlayerActionRequiredPayload }
  | { type: 'sessionPaused'; payload: SessionPausedPayload }
  | { type: 'replayUnlocked'; payload: ReplayUnlockedPayload }
  | { type: 'gameOver'; payload: GameOverPayload }
  | { type: 'error'; payload: ErrorPayload };

/** Narrow a server message to one variant, e.g. `ServerMessageOf<'eventBatch'>`. */
export type ServerMessageOf<T extends ServerToClientType> = Extract<
  ServerToClientMessage,
  { type: T }
>;

// ── Client → server ─────────────────────────────────────────────────────────────────────────

interface StartGameCommon {
  /** Four seats in v1 (brief §15). */
  seats: SeatSource[];
  providerKind: ProviderKind;
  /** Omit to have the server generate a fresh one (brief §4 — reruns use a new seed). */
  seed?: string;
  playbackMode?: PlaybackMode;
  paceMs?: number;
}

/** The selected human seat is part of the single-player discriminant, never ambient state. */
export type StartGamePayload = StartGameCommon &
  (
    | { gameMode?: 'spectator'; humanSeat?: never }
    | { gameMode: 'singlePlayer'; humanSeat: PlayerId }
  );

export interface JumpToTurnPayload {
  turn: number;
  sequence?: number;
}

export interface SetPlaybackModePayload {
  mode: PlaybackMode;
  /**
   * Wall-clock ms one turn is shown for in live mode; 0 presents as fast as the engine
   * computes. Rides here rather than adding a message type (ADR 0012).
   */
  paceMs?: number;
}

/** The human's answer to a `decisionPending` (brief §7.7 step 2). */
export interface ResolveHeldDecisionPayload {
  requestId: string;
  actionId: number;
  targets?: TargetChoice[];
}

export interface SetDebugFlagsPayload {
  flags: DebugFlags;
}

export interface SubmitPlayerActionPayload {
  requestId: string;
  actionId: number;
  revision: number;
  targets?: TargetChoice[];
}

/** Hide one currently offered optional activated ability across future turns. */
export interface YieldPlayerAbilityPayload {
  requestId: string;
  actionId: number;
  revision: number;
}

/** Restore an ability previously hidden with `yieldPlayerAbility`. */
export interface ResumePlayerAbilityPayload {
  key: string;
}

export interface ResumeGamePayload {
  sessionToken: string;
}

export type ClientToServerMessage =
  | { type: 'startGame'; payload: StartGamePayload }
  | { type: 'jumpToTurn'; payload: JumpToTurnPayload }
  | { type: 'setPlaybackMode'; payload: SetPlaybackModePayload }
  | { type: 'resolveHeldDecision'; payload: ResolveHeldDecisionPayload }
  | { type: 'abandonGame'; payload: Record<string, never> }
  | { type: 'setDebugFlags'; payload: SetDebugFlagsPayload }
  | { type: 'submitPlayerAction'; payload: SubmitPlayerActionPayload }
  | { type: 'yieldPlayerAbility'; payload: YieldPlayerAbilityPayload }
  | { type: 'resumePlayerAbility'; payload: ResumePlayerAbilityPayload }
  | { type: 'resumeGame'; payload: ResumeGamePayload };

/** Narrow a client message to one variant, e.g. `ClientMessageOf<'startGame'>`. */
export type ClientMessageOf<T extends ClientToServerType> = Extract<
  ClientToServerMessage,
  { type: T }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isTargets(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (target) =>
          isRecord(target) &&
          Number.isInteger(target['slot']) &&
          (target['slot'] as number) >= 0 &&
          typeof target['choice'] === 'string',
      ))
  );
}

function isSeatSource(value: unknown): value is SeatSource {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'pool':
      return isOptionalString(value['seed']);
    case 'url':
      return typeof value['url'] === 'string' && isOptionalString(value['archetypeTag']);
    case 'plaintext':
      return (
        typeof value['text'] === 'string' &&
        isOptionalString(value['name']) &&
        isOptionalString(value['archetypeTag'])
      );
    default:
      return false;
  }
}

function isDebugFlags(value: unknown): value is DebugFlags {
  if (!isRecord(value)) return false;
  return (
    typeof value['showAIRequests'] === 'boolean' &&
    typeof value['showAIResponses'] === 'boolean' &&
    typeof value['showLegalActions'] === 'boolean' &&
    typeof value['showSBAChecks'] === 'boolean' &&
    typeof value['showPriorityPasses'] === 'boolean' &&
    typeof value['showTokenUsage'] === 'boolean' &&
    typeof value['verboseEngine'] === 'boolean'
  );
}

/**
 * Runtime guard for the client→server direction. The server must never trust a socket frame,
 * and the union above is erased at runtime, so the `type` discriminant is checked here.
 */
export function isClientToServerMessage(value: unknown): value is ClientToServerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; payload?: unknown };
  if (typeof candidate.type !== 'string') return false;
  if (!(CLIENT_TO_SERVER_TYPES as readonly string[]).includes(candidate.type)) return false;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return false;
  const payload = candidate.payload as Record<string, unknown>;
  switch (candidate.type) {
    case 'startGame':
      return (
        Array.isArray(payload['seats']) &&
        payload['seats'].every(isSeatSource) &&
        (payload['providerKind'] === 'random' || payload['providerKind'] === 'ai') &&
        (payload['gameMode'] === undefined ||
          payload['gameMode'] === 'spectator' ||
          payload['gameMode'] === 'singlePlayer') &&
        (payload['gameMode'] === 'singlePlayer'
          ? ['P1', 'P2', 'P3', 'P4'].includes(String(payload['humanSeat']))
          : payload['humanSeat'] === undefined) &&
        isOptionalString(payload['seed']) &&
        (payload['playbackMode'] === undefined ||
          payload['playbackMode'] === 'live' ||
          payload['playbackMode'] === 'manual') &&
        (payload['paceMs'] === undefined ||
          (isFiniteNumber(payload['paceMs']) && payload['paceMs'] >= 0))
      );
    case 'jumpToTurn':
      return (
        Number.isInteger(payload['turn']) &&
        (payload['turn'] as number) >= 0 &&
        (payload['sequence'] === undefined ||
          (Number.isInteger(payload['sequence']) && (payload['sequence'] as number) >= 0))
      );
    case 'setPlaybackMode':
      return (
        (payload['mode'] === 'live' || payload['mode'] === 'manual') &&
        (payload['paceMs'] === undefined ||
          (isFiniteNumber(payload['paceMs']) && payload['paceMs'] >= 0))
      );
    case 'resolveHeldDecision':
      return (
        typeof payload['requestId'] === 'string' &&
        Number.isInteger(payload['actionId']) &&
        (payload['actionId'] as number) >= 0 &&
        isTargets(payload['targets'])
      );
    case 'submitPlayerAction':
      return (
        typeof payload['requestId'] === 'string' &&
        Number.isInteger(payload['actionId']) &&
        (payload['actionId'] as number) >= 0 &&
        Number.isInteger(payload['revision']) &&
        (payload['revision'] as number) >= 0 &&
        isTargets(payload['targets'])
      );
    case 'yieldPlayerAbility':
      return (
        typeof payload['requestId'] === 'string' &&
        Number.isInteger(payload['actionId']) &&
        (payload['actionId'] as number) >= 0 &&
        Number.isInteger(payload['revision']) &&
        (payload['revision'] as number) >= 0
      );
    case 'resumePlayerAbility':
      return typeof payload['key'] === 'string' && payload['key'].length > 0;
    case 'resumeGame':
      return typeof payload['sessionToken'] === 'string' && payload['sessionToken'].length > 0;
    case 'setDebugFlags':
      return isDebugFlags(payload['flags']);
    case 'abandonGame':
      return Object.keys(payload).length === 0;
  }
  return false;
}
