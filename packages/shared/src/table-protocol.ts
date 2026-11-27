/**
 * Table protocol (ADR 0031, plan M3): the lobby and seat-resume messages of a multiplayer table.
 *
 * The table server never registers the tester's message set, and the tester never registers
 * this one. In-game messages (`submitPlayerAction` and so on) keep their own definitions in
 * `protocol.ts`; this file holds only what a table adds.
 *
 * Envelope: `{ type, payload }`, as in `protocol.ts`. A message with no fields still carries
 * `payload: {}`.
 */

import { parseStrictJson } from './json';
import type { PlayerId } from './ids';
import type { ValidationCode } from './decks';
import type { GameResult } from './state';
import type { SpectatorState } from './spectator';
import { isPlayerSeatId } from './protocol';

/**
 * Bump when a table message changes shape. A client that sends another version gets
 * `protocolMismatch` and nothing else.
 */
export const PROTOCOL_VERSION = 2;

/** Largest accepted plaintext decklist, in UTF-16 code units (64 KiB of ASCII). */
export const TABLE_MAX_DECKLIST_CHARS = 65_536;
/** Largest accepted token or invite string. The real ones are 22 to 43 characters. */
export const TABLE_MAX_TOKEN_CHARS = 128;
/** Largest accepted raw display name, before the table trims and cleans it. */
export const TABLE_MAX_RAW_NAME_CHARS = 256;

// ── Shared vocabulary ───────────────────────────────────────────────────────────────────────

/** What a client asks the server to do or not do for it. Every field is opt-in. */
export interface TableCapabilities {
  /** Receive raw `LegalAction.data` (ADR 0032 decision 7). */
  rawActionData?: boolean;
}

export type TablePhase = 'open' | 'starting' | 'playing' | 'finished' | 'reaped';

/**
 * Who plays a seat. `open` is a seat nobody has taken and the host has not given to a bot. `bot` is
 * the built-in heuristic bot; `model` is a model-driven bot (ADR 0055), offered only when the
 * server says so (`TableStatePayload.modelSeats`).
 */
export type TableSeatController = 'open' | 'bot' | 'model' | 'human';

/** The controllers the host may set directly. A seat becomes `human` only by an approved claim. */
export type HostSeatController = 'bot' | 'model' | 'open';

export type TableClockMode = 'off' | 'relaxed' | 'standard';

export type TableDeckProblemCode = ValidationCode | 'parse' | 'unresolved' | 'tooLarge';

export interface TableDeckProblem {
  code: TableDeckProblemCode;
  message: string;
  cardName?: string;
}

/**
 * One premade deck a player can pick instead of pasting a list (`GET /tables/decks`). `text` is
 * the plaintext list, which the client sends unchanged as its `requestSeat` decklist, so the
 * table checks it like any other.
 */
export interface TablePremadeDeck {
  slug: string;
  name: string;
  commanderNames: string[];
  /** WUBRG letters of the commanders' color identity. */
  colorIdentity: string[];
  archetypeTag: string;
  text: string;
}

// ── Client to server ────────────────────────────────────────────────────────────────────────

export const TABLE_CLIENT_TO_SERVER_TYPES = [
  'joinTable',
  'requestSeat',
  'leaveSeat',
  'hostAuth',
  'hostApprove',
  'hostDeny',
  'hostSetSeat',
  'hostKick',
  'hostResolveSeat',
  'hostRotateInvite',
  'hostStart',
  'hostAbandon',
  'resumeSeat',
  'resumeControl',
  'replayTurn',
] as const;
export type TableClientToServerType = (typeof TABLE_CLIENT_TO_SERVER_TYPES)[number];

export interface JoinTablePayload {
  inviteCode: string;
  displayName: string;
  protocolVersion: number;
  capabilities: TableCapabilities;
}
export interface RequestSeatPayload {
  seat: PlayerId;
  /** Plaintext decklist. Parsed in memory; never fetched, never a saved-deck id. */
  decklist: string;
}
export interface HostAuthPayload {
  hostToken: string;
}
export interface ClaimIdPayload {
  claimId: string;
}
export interface HostSetSeatPayload {
  seat: PlayerId;
  controller: HostSeatController;
}
export interface HostKickPayload {
  seat: PlayerId;
}
/** The host has the fallback bot answer this seat's pending decision once. */
export interface HostResolveSeatPayload {
  seat: PlayerId;
}
export interface ResumeSeatPayload {
  seatToken: string;
  protocolVersion: number;
  capabilities: TableCapabilities;
}
export interface ReplayTurnPayload {
  turn: number;
}
export type EmptyPayload = Record<string, never>;

export type TableClientToServerMessage =
  | { type: 'joinTable'; payload: JoinTablePayload }
  | { type: 'requestSeat'; payload: RequestSeatPayload }
  | { type: 'leaveSeat'; payload: EmptyPayload }
  | { type: 'hostAuth'; payload: HostAuthPayload }
  | { type: 'hostApprove'; payload: ClaimIdPayload }
  | { type: 'hostDeny'; payload: ClaimIdPayload }
  | { type: 'hostSetSeat'; payload: HostSetSeatPayload }
  | { type: 'hostKick'; payload: HostKickPayload }
  | { type: 'hostResolveSeat'; payload: HostResolveSeatPayload }
  | { type: 'hostRotateInvite'; payload: EmptyPayload }
  | { type: 'hostStart'; payload: EmptyPayload }
  | { type: 'hostAbandon'; payload: EmptyPayload }
  | { type: 'resumeSeat'; payload: ResumeSeatPayload }
  | { type: 'resumeControl'; payload: EmptyPayload }
  | { type: 'replayTurn'; payload: ReplayTurnPayload };

export type TableClientMessageOf<T extends TableClientToServerType> = Extract<
  TableClientToServerMessage,
  { type: T }
>;

// ── Server to client ────────────────────────────────────────────────────────────────────────

export const TABLE_SERVER_TO_CLIENT_TYPES = [
  'tableState',
  'claimPending',
  'seatGranted',
  'deckProblems',
  'seatTakenOver',
  'protocolMismatch',
  'tableClosed',
  'tableResults',
  'replayTurnState',
  'clockState',
  'seatStatus',
  'aiBudget',
] as const;
export type TableServerToClientType = (typeof TABLE_SERVER_TO_CLIENT_TYPES)[number];

export interface TableSeatView {
  seat: PlayerId;
  controller: TableSeatController;
  /** The seated player's display name; `null` for an open or bot seat. */
  displayName: string | null;
  /** Whether a socket is currently bound to a human seat. Always `false` otherwise. */
  connected: boolean;
}

/** A claim as the host sees it. */
export interface TablePendingClaimView {
  claimId: string;
  seat: PlayerId;
  displayName: string;
  /** Short code the claimant sees too, so the host can tell who asked. */
  verificationCode: string;
}

/** What the receiving socket itself holds. */
export interface TableYouView {
  displayName: string | null;
  /** The seat this socket's player holds, or `null`. Never carries the seat token. */
  seat: PlayerId | null;
  /** This socket's own pending claim, if any. */
  claim: { claimId: string; seat: PlayerId; verificationCode: string } | null;
  isHost: boolean;
}

export interface TableStatePayload {
  tableId: string;
  phase: TablePhase;
  seats: TableSeatView[];
  /** Present for the host only. */
  pendingClaims?: TablePendingClaimView[];
  /** The current invite code. Host only, so a rotation reaches the host that asked for it. */
  inviteCode?: string;
  /** Whether `hostStart` would be accepted right now. */
  canStart: boolean;
  /** Why not, in short fixed phrases. Empty when `canStart`. */
  startBlockers: string[];
  insecureLan: boolean;
  /** `null` until clocks exist (M4). */
  clock: TableClockMode | null;
  /** Whether this server offers model-driven seats (ADR 0055); the host may set `model` only then. */
  modelSeats: boolean;
  you: TableYouView;
}

export interface ClaimPendingPayload {
  claimId: string;
  seat: PlayerId;
  /** The code the host sees beside this claim. */
  verificationCode: string;
}
export interface SeatGrantedPayload {
  seat: PlayerId;
  /** The seat's identity from here on. Sent once, to the claimant only. */
  seatToken: string;
}
export interface DeckProblemsPayload {
  seat: PlayerId | null;
  problems: TableDeckProblem[];
}
export interface SeatTakenOverPayload {
  seat: PlayerId;
}
export interface ProtocolMismatchPayload {
  serverVersion: number;
  clientVersion: number;
}
export type TableClosedReason = 'kicked' | 'reaped' | 'abandoned';
export interface TableClosedPayload {
  reason: TableClosedReason;
}

/**
 * How a started table ended. `gameOver` is a committed game result (a win, a draw, a turn cap or
 * an engine halt); the others interrupted the game, or its setup, and have no result.
 */
export type TableEnding = 'gameOver' | 'setupFailed' | 'workerFailure' | 'hostAbandoned';

/** One seat's deck as the post-game view lists it. */
export interface TableResultsDeck {
  seat: PlayerId;
  controller: 'human' | 'bot' | 'model';
  displayName: string | null;
  commanderNames: string[];
  cards: Array<{ name: string; quantity: number }>;
}

/**
 * The post-game record, sent to each seat once the game's worker has stopped and its end is
 * committed. Nothing here describes a turn or an outcome that was not saved: an interrupted game
 * lists the turns its committed snapshots cover, and a game that never started lists none.
 */
export interface TableResultsPayload {
  ending: TableEnding;
  /** The committed result; null for an interruption. */
  result: GameResult | null;
  /** The game's ChaCha20 key, 64 hex digits; null when no key was drawn. */
  rngKey: string | null;
  decks: TableResultsDeck[];
  /** Turns `replayTurn` can show. Empty when nothing was committed. */
  replayTurns: number[];
}

/** One turn of the finished game, from the committed snapshot at that turn's start. */
export interface ReplayTurnStatePayload {
  turn: number;
  state: SpectatorState;
}

/**
 * One seat's clock (multiplayer M4), sent to every seated player when it starts, stops, pauses
 * or resumes. A client counts down from `remainingMs` while `running`; the server's own deadline
 * is the one that counts. `remainingMs` is the allowance and bank left for the decision being
 * timed, or the bank when none is.
 */
export interface ClockStatePayload {
  seat: PlayerId;
  remainingMs: number;
  bankMs: number;
  running: boolean;
}

/** Whether a seat's player is connected, and whether its fallback bot is playing it. */
export interface SeatStatusPayload {
  seat: PlayerId;
  connected: boolean;
  fallback: boolean;
}

/**
 * The table's model seats stopped calling the model and play on as built-in bots (ADR 0055):
 * the game reached its spending cap, or the provider refused the key. Sent once, to every seat.
 * It carries no amount, since spending tracks what the bots hold.
 */
export interface AiBudgetPayload {
  reason: 'cap' | 'key';
}

export type TableServerToClientMessage =
  | { type: 'tableState'; payload: TableStatePayload }
  | { type: 'claimPending'; payload: ClaimPendingPayload }
  | { type: 'seatGranted'; payload: SeatGrantedPayload }
  | { type: 'deckProblems'; payload: DeckProblemsPayload }
  | { type: 'seatTakenOver'; payload: SeatTakenOverPayload }
  | { type: 'protocolMismatch'; payload: ProtocolMismatchPayload }
  | { type: 'tableClosed'; payload: TableClosedPayload }
  | { type: 'tableResults'; payload: TableResultsPayload }
  | { type: 'replayTurnState'; payload: ReplayTurnStatePayload }
  | { type: 'clockState'; payload: ClockStatePayload }
  | { type: 'seatStatus'; payload: SeatStatusPayload }
  | { type: 'aiBudget'; payload: AiBudgetPayload };

export type TableServerMessageOf<T extends TableServerToClientType> = Extract<
  TableServerToClientMessage,
  { type: T }
>;

// ── Strict parser for the client messages ───────────────────────────────────────────────────

export type TableParseFailure =
  | 'duplicateKey'
  | 'tooDeep'
  | 'malformed'
  | 'notAnObject'
  | 'unknownType'
  | 'unknownField'
  | 'invalidPayload';

export type TableParseResult =
  { ok: true; message: TableClientToServerMessage } | { ok: false; reason: TableParseFailure };

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when `value` has exactly the keys in `allowed` (all of `required`, nothing else). */
function hasOnlyKeys(value: Fields, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value);
  for (const key of required) if (!keys.includes(key)) return false;
  return keys.every((key) => required.includes(key) || optional.includes(key));
}

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000;

const isSeat = (value: unknown): value is PlayerId => isPlayerSeatId(value);

/** Capabilities: an object with only known keys, each a boolean. Required on join and resume. */
function parseCapabilities(value: unknown): TableCapabilities | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [], ['rawActionData'])) return null;
  const raw = value['rawActionData'];
  if (raw !== undefined && typeof raw !== 'boolean') return null;
  return raw === undefined ? {} : { rawActionData: raw };
}

/**
 * Validate one decoded frame as a table client message. Refuses a type this protocol does not
 * define (the tester's messages included), a missing or non-object payload, a payload field of
 * the wrong type, and any extra field at either level. The result is a rebuilt message holding
 * only the fields read here, so nothing unvalidated rides along.
 */
export function parseTableClientMessage(value: unknown): TableParseResult {
  const fail = (reason: TableParseFailure): TableParseResult => ({ ok: false, reason });
  if (!isRecord(value)) return fail('notAnObject');
  const type = value['type'];
  if (
    typeof type !== 'string' ||
    !(TABLE_CLIENT_TO_SERVER_TYPES as readonly string[]).includes(type)
  )
    return fail('unknownType');
  if (!hasOnlyKeys(value, ['type'], ['payload'])) return fail('unknownField');
  const payload = value['payload'];
  if (!isRecord(payload)) return fail('invalidPayload');
  const ok = (message: TableClientToServerMessage): TableParseResult => ({ ok: true, message });
  const unknownField = (required: readonly string[]): boolean => !hasOnlyKeys(payload, required);

  const kind = type as TableClientToServerType;
  switch (kind) {
    case 'joinTable': {
      if (unknownField(['inviteCode', 'displayName', 'protocolVersion', 'capabilities']))
        return fail('unknownField');
      const capabilities = parseCapabilities(payload['capabilities']);
      if (
        !isBoundedString(payload['inviteCode'], TABLE_MAX_TOKEN_CHARS) ||
        !isBoundedString(payload['displayName'], TABLE_MAX_RAW_NAME_CHARS) ||
        !isVersion(payload['protocolVersion']) ||
        capabilities === null
      )
        return fail('invalidPayload');
      return ok({
        type: 'joinTable',
        payload: {
          inviteCode: payload['inviteCode'],
          displayName: payload['displayName'],
          protocolVersion: payload['protocolVersion'],
          capabilities,
        },
      });
    }
    case 'requestSeat': {
      if (unknownField(['seat', 'decklist'])) return fail('unknownField');
      if (
        !isSeat(payload['seat']) ||
        !isBoundedString(payload['decklist'], TABLE_MAX_DECKLIST_CHARS)
      )
        return fail('invalidPayload');
      return ok({
        type: 'requestSeat',
        payload: { seat: payload['seat'], decklist: payload['decklist'] },
      });
    }
    case 'hostAuth': {
      if (unknownField(['hostToken'])) return fail('unknownField');
      if (!isBoundedString(payload['hostToken'], TABLE_MAX_TOKEN_CHARS))
        return fail('invalidPayload');
      return ok({ type: 'hostAuth', payload: { hostToken: payload['hostToken'] } });
    }
    case 'hostApprove':
    case 'hostDeny': {
      if (unknownField(['claimId'])) return fail('unknownField');
      if (!isBoundedString(payload['claimId'], TABLE_MAX_TOKEN_CHARS))
        return fail('invalidPayload');
      return ok({ type: kind, payload: { claimId: payload['claimId'] } });
    }
    case 'hostSetSeat': {
      if (unknownField(['seat', 'controller'])) return fail('unknownField');
      const controller = payload['controller'];
      if (
        !isSeat(payload['seat']) ||
        (controller !== 'bot' && controller !== 'model' && controller !== 'open')
      )
        return fail('invalidPayload');
      return ok({ type: 'hostSetSeat', payload: { seat: payload['seat'], controller } });
    }
    case 'hostKick':
    case 'hostResolveSeat': {
      if (unknownField(['seat'])) return fail('unknownField');
      if (!isSeat(payload['seat'])) return fail('invalidPayload');
      return ok({ type: kind, payload: { seat: payload['seat'] } });
    }
    case 'resumeSeat': {
      if (unknownField(['seatToken', 'protocolVersion', 'capabilities']))
        return fail('unknownField');
      const capabilities = parseCapabilities(payload['capabilities']);
      if (
        !isBoundedString(payload['seatToken'], TABLE_MAX_TOKEN_CHARS) ||
        !isVersion(payload['protocolVersion']) ||
        capabilities === null
      )
        return fail('invalidPayload');
      return ok({
        type: 'resumeSeat',
        payload: {
          seatToken: payload['seatToken'],
          protocolVersion: payload['protocolVersion'],
          capabilities,
        },
      });
    }
    case 'replayTurn': {
      if (unknownField(['turn'])) return fail('unknownField');
      const turn = payload['turn'];
      if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0 || turn > 100_000)
        return fail('invalidPayload');
      return ok({ type: 'replayTurn', payload: { turn } });
    }
    case 'leaveSeat':
    case 'hostRotateInvite':
    case 'hostStart':
    case 'hostAbandon':
    case 'resumeControl':
      if (unknownField([])) return fail('unknownField');
      return ok({ type: kind, payload: {} });
  }
}

/** Parse raw frame text: strict JSON first (repeated keys refused), then the table parser. */
export function parseTableClientFrame(text: string): TableParseResult {
  const strict = parseStrictJson(text);
  if (!strict.ok) return { ok: false, reason: strict.reason };
  return parseTableClientMessage(strict.value);
}
