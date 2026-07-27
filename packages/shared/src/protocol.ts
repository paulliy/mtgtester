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
] as const;
export type ClientToServerType = (typeof CLIENT_TO_SERVER_TYPES)[number];

// ── Shared vocabulary ───────────────────────────────────────────────────────────────────────

/**
 * Who answers decisions. `random` is free and deterministic given the seed; `ai` spends real
 * budget on every non-local decision (ADR 0010, ADR 0011). See ADR 0012 §4.
 */
export type ProviderKind = 'random' | 'ai';

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
  | { type: 'gameOver'; payload: GameOverPayload }
  | { type: 'error'; payload: ErrorPayload };

/** Narrow a server message to one variant, e.g. `ServerMessageOf<'eventBatch'>`. */
export type ServerMessageOf<T extends ServerToClientType> = Extract<
  ServerToClientMessage,
  { type: T }
>;

// ── Client → server ─────────────────────────────────────────────────────────────────────────

export interface StartGamePayload {
  /** Four seats in v1 (brief §15). */
  seats: SeatSource[];
  providerKind: ProviderKind;
  /** Omit to have the server generate a fresh one (brief §4 — reruns use a new seed). */
  seed?: string;
  playbackMode?: PlaybackMode;
}

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

export type ClientToServerMessage =
  | { type: 'startGame'; payload: StartGamePayload }
  | { type: 'jumpToTurn'; payload: JumpToTurnPayload }
  | { type: 'setPlaybackMode'; payload: SetPlaybackModePayload }
  | { type: 'resolveHeldDecision'; payload: ResolveHeldDecisionPayload }
  | { type: 'abandonGame'; payload: Record<string, never> };

/** Narrow a client message to one variant, e.g. `ClientMessageOf<'startGame'>`. */
export type ClientMessageOf<T extends ClientToServerType> = Extract<
  ClientToServerMessage,
  { type: T }
>;

/**
 * Runtime guard for the client→server direction. The server must never trust a socket frame,
 * and the union above is erased at runtime, so the `type` discriminant is checked here.
 */
export function isClientToServerMessage(value: unknown): value is ClientToServerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; payload?: unknown };
  if (typeof candidate.type !== 'string') return false;
  if (!(CLIENT_TO_SERVER_TYPES as readonly string[]).includes(candidate.type)) return false;
  return typeof candidate.payload === 'object' && candidate.payload !== null;
}
