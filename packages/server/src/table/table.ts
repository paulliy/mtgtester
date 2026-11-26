/**
 * The lobby state machine of one table (ADR 0031 decision 6, plan M3 "Lobby state machine").
 *
 * ```
 * open ──hostStart (≥1 human, every seat human or bot, every deck valid)──▶ starting
 * starting ──startSucceeded──▶ playing      starting ──startRejected──▶ open
 * starting/playing ──gameFinished──▶ finished      finished ──idle──▶ reaped
 * ```
 *
 * This class does no I/O. Every method takes the calling connection, changes state, and returns a
 * result carrying `effects`: messages to send, sockets to close, and the two instructions part B
 * carries out (`startGame` and `abandonGame`). Persistence, workers, sockets and the match
 * session are not here. Part B drives the three lifecycle calls `startSucceeded`,
 * `startRejected` and `gameFinished`.
 *
 * Authority:
 * - Joining needs the invite code, compared in constant time and throttled per client address.
 * - Host messages need `hostAuth` with the host token on the same connection.
 * - A seat is granted only by `hostApprove` on a claim id, and its 256-bit token is revoked by
 *   kick, leave, seat change or a rejected start.
 * - Everything but `hostAuth`, `resumeSeat` and `hostAbandon` is refused outside `open`.
 */

import type {
  HostSeatController,
  PlayerId,
  ResolvedDeck,
  TableCapabilities,
  TableClockMode,
  TableDeckProblem,
  TablePhase,
  TableSeatController,
  TableServerToClientMessage,
  TableStatePayload,
} from '@mtg/shared';
import { PLAYER_SEAT_IDS, PROTOCOL_VERSION } from '@mtg/shared';
import type { DeckChecker } from './deck-check';
import {
  AttemptThrottle,
  cleanDisplayName,
  constantTimeEqual,
  generateAttemptId,
  generateClaimId,
  generateHostToken,
  generateInviteCode,
  generateSeatToken,
  generateTableId,
  generateVerificationCode,
  normalizeDisplayName,
} from './tokens';

// ── Public types ────────────────────────────────────────────────────────────────────────────

/** The calling connection. The table never sees a socket, only these two strings. */
export interface Connection {
  socketId: string;
  /** The client address the throttle and the per-address claim cap key on. */
  address: string;
}

export interface TableLimits {
  /** Pending claims across the table. */
  pendingClaimsPerTable: number;
  pendingClaimsPerSocket: number;
  pendingClaimsPerAddress: number;
  /** Connected lobby sockets, so one invite cannot grow the table without bound. */
  maxConnections: number;
  /** How long a `finished` table lingers before `reapIfIdle` reaps it. */
  finishedIdleMs: number;
  /** Takeovers of one seat (a second socket resuming it) allowed per minute (plan M5 task 2). */
  takeoversPerMinute: number;
}

export const DEFAULT_TABLE_LIMITS: TableLimits = {
  pendingClaimsPerTable: 8,
  pendingClaimsPerSocket: 1,
  pendingClaimsPerAddress: 2,
  maxConnections: 32,
  finishedIdleMs: 15 * 60_000,
  takeoversPerMinute: 6,
};

export interface TableOptions {
  /** Generated when omitted. */
  tableId?: string;
  hostToken?: string;
  inviteCode?: string;
  deckChecker: DeckChecker;
  now?: () => number;
  /** Shared across tables by a registry, or one per table by default. */
  throttle?: AttemptThrottle;
  insecureLan?: boolean;
  clock?: TableClockMode | null;
  limits?: Partial<TableLimits>;
  /** Whether the host may give a seat to a model-driven bot (ADR 0055). Off by default. */
  modelSeats?: boolean;
}

/** One seat of a start attempt. A human seat carries the approved, validated deck. */
export type StartAttemptSeat =
  | {
      seat: PlayerId;
      controller: 'human';
      displayName: string;
      decklist: string;
      deck: ResolvedDeck;
    }
  | { seat: PlayerId; controller: 'bot' | 'model' };

/**
 * What part B needs to start one game: the table, a fresh attempt id, and every seat. The table
 * emits this once per accepted `hostStart` and never again for the same attempt.
 */
export interface StartAttempt {
  attemptId: string;
  tableId: string;
  seats: StartAttemptSeat[];
}

export type TableEffect =
  /** Send one message to one socket. */
  | { type: 'send'; socketId: string; message: TableServerToClientMessage }
  /** Close a socket after its pending messages. */
  | { type: 'close'; socketId: string; reason: 'kicked' | 'takenOver' | 'reaped' }
  /** Part B: start this game. Emitted once per attempt. */
  | { type: 'startGame'; attempt: StartAttempt }
  /** Part B: stop the running attempt (fence, terminate, commit `hostAbandoned`). Once. */
  | { type: 'abandonGame'; attemptId: string }
  /** Part B: the host approved this claim, so the deck may now be stored under a table-scoped id. */
  | { type: 'deckApproved'; seat: PlayerId; displayName: string; decklist: string };

export type Refusal =
  | 'wrongPhase'
  | 'protocolMismatch'
  | 'throttled'
  | 'badInvite'
  | 'badToken'
  | 'notJoined'
  | 'notHost'
  | 'alreadyJoined'
  | 'badName'
  | 'nameTaken'
  | 'tableFull'
  | 'unknownSeat'
  | 'seatUnavailable'
  | 'alreadySeated'
  | 'claimLimitTable'
  | 'claimLimitSocket'
  | 'claimLimitAddress'
  | 'deckInvalid'
  | 'unknownClaim'
  | 'noSeat'
  | 'noPlayer'
  | 'cannotStart'
  | 'staleAttempt'
  | 'alreadyAbandoning'
  /** `hostSetSeat` asked for a model seat on a server that does not offer them. */
  | 'modelSeatsOff';

export type TableResult<Extra extends object = object> =
  | ({ ok: true; effects: TableEffect[] } & Extra)
  | {
      ok: false;
      reason: Refusal;
      effects: TableEffect[];
      /** Set when `reason` is `throttled`: wait this long, then try again. */
      retryAfterMs?: number;
      /** Set on `nameTaken` when the names differ as typed and match only after folding. */
      lookalike?: boolean;
      /** Set on `cannotStart`. */
      blockers?: string[];
    };

// ── Internal records ────────────────────────────────────────────────────────────────────────

interface Conn {
  socketId: string;
  address: string;
  displayName: string | null;
  normalizedName: string | null;
  seat: PlayerId | null;
  isHost: boolean;
  capabilities: TableCapabilities;
}

interface SeatPlayer {
  displayName: string;
  normalizedName: string;
  seatToken: string;
  /** The socket currently bound to the seat, or `null` while the player is away. */
  socketId: string | null;
  decklist: string;
  deck: ResolvedDeck;
}

interface SeatRecord {
  seat: PlayerId;
  controller: TableSeatController;
  player: SeatPlayer | null;
}

interface Claim {
  claimId: string;
  seat: PlayerId;
  socketId: string;
  address: string;
  displayName: string;
  verificationCode: string;
  decklist: string;
  deck: ResolvedDeck;
}

interface Attempt {
  attemptId: string;
  abandonRequested: boolean;
}

// ── The table ───────────────────────────────────────────────────────────────────────────────

export class Table {
  readonly id: string;
  private readonly hostToken: string;
  private inviteCode: string;
  private readonly deckChecker: DeckChecker;
  private readonly now: () => number;
  private readonly throttle: AttemptThrottle;
  private readonly insecureLan: boolean;
  private readonly clock: TableClockMode | null;
  private readonly limits: TableLimits;
  private readonly modelSeats: boolean;

  private phase: TablePhase = 'open';
  private finishedAt: number | null = null;
  /** Since when an `open` table has had no connection at all; `null` while one is connected. */
  private emptySince: number | null;
  private attempt: Attempt | null = null;
  private readonly seats = new Map<PlayerId, SeatRecord>();
  /** When each seat was last taken over by a new socket, for the takeover limit. */
  private readonly takeovers = new Map<PlayerId, number[]>();
  private readonly conns = new Map<string, Conn>();
  private readonly claims = new Map<string, Claim>();

  constructor(options: TableOptions) {
    this.id = options.tableId ?? generateTableId();
    this.hostToken = options.hostToken ?? generateHostToken();
    this.inviteCode = options.inviteCode ?? generateInviteCode();
    this.deckChecker = options.deckChecker;
    this.now = options.now ?? Date.now;
    this.throttle = options.throttle ?? new AttemptThrottle({ now: this.now });
    this.insecureLan = options.insecureLan ?? false;
    this.clock = options.clock ?? null;
    this.limits = { ...DEFAULT_TABLE_LIMITS, ...options.limits };
    this.modelSeats = options.modelSeats ?? false;
    this.emptySince = this.now();
    for (const seat of PLAYER_SEAT_IDS) {
      this.seats.set(seat, { seat, controller: 'open', player: null });
    }
  }

  // ── Read side ─────────────────────────────────────────────────────────────────────────────

  get currentPhase(): TablePhase {
    return this.phase;
  }

  /** The host token, for the registry to return once to whoever created the table. */
  get issuedHostToken(): string {
    return this.hostToken;
  }

  /** The current invite code, for the registry to build the invite link. */
  get currentInviteCode(): string {
    return this.inviteCode;
  }

  /** The seat a socket's player holds, or `null`. This is the table's side of socket binding. */
  seatOfSocket(socketId: string): PlayerId | null {
    const conn = this.conns.get(socketId);
    if (conn === undefined || conn.seat === null) return null;
    return this.seats.get(conn.seat)?.player?.socketId === socketId ? conn.seat : null;
  }

  capabilitiesOf(socketId: string): TableCapabilities | null {
    return this.conns.get(socketId)?.capabilities ?? null;
  }

  isHost(socketId: string): boolean {
    return this.conns.get(socketId)?.isHost === true;
  }

  /** The `tableState` message this socket would receive now. */
  stateFor(socketId: string): TableServerToClientMessage | null {
    const conn = this.conns.get(socketId);
    return conn === undefined ? null : this.stateMessage(conn);
  }

  /** Whether `hostStart` would be accepted, and if not, why (fixed phrases). */
  startBlockers(): string[] {
    if (this.phase !== 'open') return [];
    const blockers: string[] = [];
    let humans = 0;
    for (const record of this.seats.values()) {
      if (record.controller === 'human') humans += 1;
      else if (record.controller === 'open') blockers.push(`Seat ${record.seat} is not assigned.`);
    }
    if (humans === 0) blockers.unshift('At least one human must take a seat.');
    return blockers;
  }

  /**
   * What a holder of the invite may read before joining (the summary endpoint): the phase and
   * who plays each seat. No names, tokens or claims.
   */
  publicSummary(): {
    tableId: string;
    phase: TablePhase;
    joinable: boolean;
    seats: { seat: PlayerId; controller: TableSeatController }[];
  } {
    return {
      tableId: this.id,
      phase: this.phase,
      joinable: this.phase === 'open',
      seats: [...this.seats.values()].map((record) => ({
        seat: record.seat,
        controller: record.controller,
      })),
    };
  }

  // ── Lobby: any holder of the invite ───────────────────────────────────────────────────────

  join(
    conn: Connection,
    payload: {
      inviteCode: string;
      displayName: string;
      protocolVersion: number;
      capabilities: TableCapabilities;
    },
  ): TableResult {
    const mismatch = this.versionMismatch(conn, payload.protocolVersion);
    if (mismatch !== null) return mismatch;
    if (this.phase === 'reaped') return refuse('wrongPhase');
    const wait = this.throttle.check(conn.address);
    if (wait > 0) return refuse('throttled', { retryAfterMs: wait });
    if (!constantTimeEqual(payload.inviteCode, this.inviteCode)) {
      this.throttle.fail(conn.address);
      return refuse('badInvite');
    }
    this.throttle.succeed(conn.address);
    if (this.phase !== 'open') return refuse('wrongPhase');
    const existing = this.conns.get(conn.socketId);
    if (existing?.displayName != null) return refuse('alreadyJoined');
    if (existing === undefined && this.conns.size >= this.limits.maxConnections) {
      return refuse('tableFull');
    }
    const displayName = cleanDisplayName(payload.displayName);
    if (displayName === null) return refuse('badName');
    const normalizedName = normalizeDisplayName(displayName);
    const taken = this.nameConflict(normalizedName, conn.socketId);
    if (taken !== null) {
      return refuse('nameTaken', { lookalike: taken.displayName !== payload.displayName });
    }
    const record = existing ?? this.register(conn);
    record.displayName = displayName;
    record.normalizedName = normalizedName;
    record.capabilities = { ...payload.capabilities };
    return ok(this.broadcastState());
  }

  requestSeat(
    conn: Connection,
    payload: { seat: PlayerId; decklist: string },
  ): TableResult<{
    claimId: string;
    verificationCode: string;
  }> {
    const caller = this.conns.get(conn.socketId);
    if (caller === undefined || caller.displayName === null) return refuse('notJoined');
    if (this.phase !== 'open') return refuse('wrongPhase');
    const record = this.seats.get(payload.seat);
    if (record === undefined) return refuse('unknownSeat');
    if (caller.seat !== null) return refuse('alreadySeated');
    const pending = [...this.claims.values()];
    if (pending.some((claim) => claim.socketId === conn.socketId)) {
      return refuse('claimLimitSocket');
    }
    if (pending.length >= this.limits.pendingClaimsPerTable) return refuse('claimLimitTable');
    if (
      pending.filter((claim) => claim.address === caller.address).length >=
      this.limits.pendingClaimsPerAddress
    ) {
      return refuse('claimLimitAddress');
    }
    if (record.controller !== 'open') return refuse('seatUnavailable');

    const checked = this.deckChecker(payload.decklist);
    if (!checked.ok) {
      return refuse('deckInvalid', {
        effects: [
          sendTo(conn.socketId, {
            type: 'deckProblems',
            payload: { seat: payload.seat, problems: checked.problems },
          }),
        ],
      });
    }
    const claim: Claim = {
      claimId: generateClaimId(),
      seat: payload.seat,
      socketId: conn.socketId,
      address: caller.address,
      displayName: caller.displayName,
      verificationCode: generateVerificationCode(),
      decklist: payload.decklist,
      deck: checked.deck,
    };
    this.claims.set(claim.claimId, claim);
    return ok(
      [
        sendTo(conn.socketId, {
          type: 'claimPending',
          payload: {
            claimId: claim.claimId,
            seat: claim.seat,
            verificationCode: claim.verificationCode,
          },
        }),
        ...this.broadcastState(),
      ],
      { claimId: claim.claimId, verificationCode: claim.verificationCode },
    );
  }

  leaveSeat(conn: Connection): TableResult {
    const caller = this.conns.get(conn.socketId);
    if (caller === undefined || caller.displayName === null) return refuse('notJoined');
    if (this.phase !== 'open') return refuse('wrongPhase');
    let changed = false;
    if (caller.seat !== null) {
      this.vacate(caller.seat);
      changed = true;
    }
    for (const claim of [...this.claims.values()]) {
      if (claim.socketId === conn.socketId) {
        this.claims.delete(claim.claimId);
        changed = true;
      }
    }
    if (!changed) return refuse('noSeat');
    return ok(this.broadcastState());
  }

  // ── Lobby: the host ───────────────────────────────────────────────────────────────────────

  /** Allowed in every phase before `reaped`: the host needs it to abandon a running game. */
  hostAuth(conn: Connection, payload: { hostToken: string }): TableResult {
    if (this.phase === 'reaped') return refuse('wrongPhase');
    const wait = this.throttle.check(conn.address);
    if (wait > 0) return refuse('throttled', { retryAfterMs: wait });
    if (!constantTimeEqual(payload.hostToken, this.hostToken)) {
      this.throttle.fail(conn.address);
      return refuse('badToken');
    }
    this.throttle.succeed(conn.address);
    if (this.conns.size >= this.limits.maxConnections && !this.conns.has(conn.socketId)) {
      return refuse('tableFull');
    }
    const record = this.conns.get(conn.socketId) ?? this.register(conn);
    record.isHost = true;
    const state = this.stateMessage(record);
    return ok([sendTo(conn.socketId, state)]);
  }

  hostApprove(conn: Connection, payload: { claimId: string }): TableResult<{ seat: PlayerId }> {
    const gate = this.hostGate(conn);
    if (gate !== null) return gate;
    const claim = this.claims.get(payload.claimId);
    if (claim === undefined) return refuse('unknownClaim');
    const record = this.seats.get(claim.seat);
    const claimant = this.conns.get(claim.socketId);
    if (record === undefined || record.controller !== 'open' || claimant === undefined) {
      this.claims.delete(claim.claimId);
      return refuse('unknownClaim');
    }
    // A socket that resumed a seat after asking holds that seat already; it cannot take a second.
    if (this.seatOfSocket(claim.socketId) !== null) {
      this.claims.delete(claim.claimId);
      return refuse('unknownClaim');
    }
    const seatToken = generateSeatToken();
    record.controller = 'human';
    record.player = {
      displayName: claim.displayName,
      normalizedName: normalizeDisplayName(claim.displayName),
      seatToken,
      socketId: claim.socketId,
      decklist: claim.decklist,
      deck: claim.deck,
    };
    claimant.seat = claim.seat;
    this.claims.delete(claim.claimId);
    // Other claims on this seat lose; their owners see the claim gone from their next state.
    for (const other of [...this.claims.values()]) {
      if (other.seat === claim.seat) this.claims.delete(other.claimId);
    }
    return ok(
      [
        sendTo(claim.socketId, { type: 'seatGranted', payload: { seat: claim.seat, seatToken } }),
        {
          type: 'deckApproved',
          seat: claim.seat,
          displayName: claim.displayName,
          decklist: claim.decklist,
        },
        ...this.broadcastState(),
      ],
      { seat: claim.seat },
    );
  }

  hostDeny(conn: Connection, payload: { claimId: string }): TableResult {
    const gate = this.hostGate(conn);
    if (gate !== null) return gate;
    if (!this.claims.delete(payload.claimId)) return refuse('unknownClaim');
    return ok(this.broadcastState());
  }

  /**
   * `bot`, `model` or `open`. A human seat is vacated first, which revokes its token. `model` is
   * refused unless this server offers model seats: only the host can add a paid seat (ADR 0055).
   */
  hostSetSeat(
    conn: Connection,
    payload: { seat: PlayerId; controller: HostSeatController },
  ): TableResult {
    const gate = this.hostGate(conn);
    if (gate !== null) return gate;
    const record = this.seats.get(payload.seat);
    if (record === undefined) return refuse('unknownSeat');
    if (payload.controller === 'model' && !this.modelSeats) return refuse('modelSeatsOff');
    if (record.controller === 'human') this.vacate(payload.seat);
    record.controller = payload.controller;
    if (payload.controller !== 'open') this.dropClaimsFor(payload.seat);
    return ok(this.broadcastState());
  }

  /** Removes the seat's player: token revoked, claims dropped, socket told and closed. */
  hostKick(conn: Connection, payload: { seat: PlayerId }): TableResult {
    const gate = this.hostGate(conn);
    if (gate !== null) return gate;
    const record = this.seats.get(payload.seat);
    if (record === undefined) return refuse('unknownSeat');
    const player = record.player;
    if (record.controller !== 'human' || player === null) return refuse('noPlayer');
    const effects: TableEffect[] = [];
    this.vacate(payload.seat);
    if (player.socketId !== null && this.conns.has(player.socketId)) {
      effects.push(
        sendTo(player.socketId, { type: 'tableClosed', payload: { reason: 'kicked' } }),
        { type: 'close', socketId: player.socketId, reason: 'kicked' },
      );
      this.removeConn(player.socketId);
    }
    return ok([...effects, ...this.broadcastState()]);
  }

  /** Replaces the invite code. The old one stops working at once. */
  hostRotateInvite(conn: Connection): TableResult<{ inviteCode: string }> {
    const gate = this.hostGate(conn);
    if (gate !== null) return gate;
    this.inviteCode = generateInviteCode();
    return ok(this.broadcastState(), { inviteCode: this.inviteCode });
  }

  /**
   * `open` to `starting`, once. The phase changes before anything is awaited, so a second
   * `hostStart` meets `starting` and is refused: one attempt, one `startGame` effect.
   */
  hostStart(conn: Connection): TableResult<{ attemptId: string }> {
    const gate = this.hostGate(conn);
    if (gate !== null) return gate;
    const blockers = this.startBlockers();
    if (blockers.length > 0) return refuse('cannotStart', { blockers });
    const seats: StartAttemptSeat[] = [];
    for (const record of this.seats.values()) {
      if (record.controller === 'bot' || record.controller === 'model') {
        seats.push({ seat: record.seat, controller: record.controller });
      } else if (record.controller === 'human' && record.player !== null) {
        seats.push({
          seat: record.seat,
          controller: 'human',
          displayName: record.player.displayName,
          decklist: record.player.decklist,
          deck: record.player.deck,
        });
      } else {
        return refuse('cannotStart', { blockers: [`Seat ${record.seat} is not assigned.`] });
      }
    }
    this.claims.clear(); // joining closes at the start
    const attemptId = generateAttemptId();
    this.attempt = { attemptId, abandonRequested: false };
    this.phase = 'starting';
    return ok(
      [
        { type: 'startGame', attempt: { attemptId, tableId: this.id, seats } },
        ...this.broadcastState(),
      ],
      { attemptId },
    );
  }

  /** While `starting` or `playing`. Emits one `abandonGame`; part B ends the game and calls back. */
  hostAbandon(conn: Connection): TableResult {
    if (this.conns.get(conn.socketId)?.isHost !== true) return refuse('notHost');
    if (this.phase !== 'starting' && this.phase !== 'playing') return refuse('wrongPhase');
    const attempt = this.attempt;
    if (attempt === null) return refuse('wrongPhase');
    if (attempt.abandonRequested) return refuse('alreadyAbandoning');
    attempt.abandonRequested = true;
    return ok([{ type: 'abandonGame', attemptId: attempt.attemptId }]);
  }

  // ── Seat connections ──────────────────────────────────────────────────────────────────────

  /**
   * Authenticate a seat token and bind this connection to the seat. A second socket with the
   * same token takes the seat over: the first is told with `seatTakenOver` and closed. Allowed
   * in every phase before `reaped`, since a seated player also returns for the post-game view.
   */
  resumeSeat(
    conn: Connection,
    payload: { seatToken: string; protocolVersion: number; capabilities: TableCapabilities },
  ): TableResult<{ seat: PlayerId }> {
    const mismatch = this.versionMismatch(conn, payload.protocolVersion);
    if (mismatch !== null) return mismatch;
    if (this.phase === 'reaped') return refuse('wrongPhase');
    const wait = this.throttle.check(conn.address);
    if (wait > 0) return refuse('throttled', { retryAfterMs: wait });
    const seat = this.seatForToken(payload.seatToken);
    if (seat === null) {
      this.throttle.fail(conn.address);
      return refuse('badToken');
    }
    this.throttle.succeed(conn.address);
    const player = this.seats.get(seat)!.player!;
    const effects: TableEffect[] = [];
    const previous = player.socketId;
    if (previous !== null && previous !== conn.socketId) {
      // A seat bounced between sockets faster than a person reconnects is refused for a while.
      const now = this.now();
      const recent = (this.takeovers.get(seat) ?? []).filter((at) => now - at < 60_000);
      if (recent.length >= this.limits.takeoversPerMinute) {
        this.takeovers.set(seat, recent);
        return refuse('throttled', { retryAfterMs: 60_000 - (now - recent[0]!) });
      }
      recent.push(now);
      this.takeovers.set(seat, recent);
      effects.push(sendTo(previous, { type: 'seatTakenOver', payload: { seat } }), {
        type: 'close',
        socketId: previous,
        reason: 'takenOver',
      });
      this.removeConn(previous);
    }
    let record = this.conns.get(conn.socketId);
    if (record === undefined) {
      if (this.conns.size >= this.limits.maxConnections) return refuse('tableFull');
      record = this.register(conn);
    }
    // One seat per socket: a socket that held another seat lets it go, so that seat's frames
    // stop reaching it.
    if (record.seat !== null && record.seat !== seat) {
      const held = this.seats.get(record.seat)?.player;
      if (held?.socketId === conn.socketId) held.socketId = null;
    }
    // A seat now bound to this socket supersedes any request it still has waiting on the host.
    for (const claim of [...this.claims.values()]) {
      if (claim.socketId === conn.socketId) this.claims.delete(claim.claimId);
    }
    record.displayName = player.displayName;
    record.normalizedName = player.normalizedName;
    record.seat = seat;
    record.capabilities = { ...payload.capabilities };
    player.socketId = conn.socketId;
    return ok([...effects, ...this.broadcastState()], { seat });
  }

  /** The seat a token opens, found without an early exit; `null` if none. Throttle is the caller's. */
  seatForToken(seatToken: string): PlayerId | null {
    let found: PlayerId | null = null;
    for (const record of this.seats.values()) {
      const candidate = record.player?.seatToken ?? '';
      // Compare against every seat so the time taken does not say which one matched.
      const equal = constantTimeEqual(seatToken, candidate);
      if (equal && record.player !== null) found = record.seat;
    }
    return found;
  }

  /** A socket went away. A seated player keeps the seat and its token. */
  disconnect(socketId: string): TableResult {
    const conn = this.conns.get(socketId);
    if (conn === undefined) return ok([]);
    this.removeConn(socketId);
    return ok(this.phase === 'reaped' ? [] : this.broadcastState());
  }

  // ── Lifecycle driven by part B ────────────────────────────────────────────────────────────

  /** Setup is done and the game is running: `starting` to `playing`. */
  startSucceeded(attemptId: string): TableResult {
    if (this.attempt?.attemptId !== attemptId || this.phase !== 'starting') {
      return refuse('staleAttempt');
    }
    this.phase = 'playing';
    return ok(this.broadcastState());
  }

  /**
   * Typed deck problems found during setup: `starting` back to `open`. The attempt is retired, so
   * later messages carrying its id are stale. Each seat named in `problems` hears only its own,
   * and loses its seat (token revoked) so its player can claim again with a corrected deck; the
   * host approves that claim afresh. Other seats are untouched.
   */
  startRejected(
    attemptId: string,
    problems: Partial<Record<PlayerId, TableDeckProblem[]>>,
  ): TableResult {
    if (this.attempt?.attemptId !== attemptId || this.phase !== 'starting') {
      return refuse('staleAttempt');
    }
    const effects: TableEffect[] = [];
    for (const [seat, list] of Object.entries(problems)) {
      const record = this.seats.get(seat);
      const player = record?.player;
      if (record === undefined || player === null || player === undefined || list === undefined) {
        continue;
      }
      if (player.socketId !== null) {
        effects.push(
          sendTo(player.socketId, { type: 'deckProblems', payload: { seat, problems: list } }),
        );
      }
      this.vacate(seat);
    }
    this.attempt = null;
    this.phase = 'open';
    if (this.conns.size === 0) this.emptySince = this.now();
    return ok([...effects, ...this.broadcastState()]);
  }

  /**
   * The game ended, halted, failed to set up or was abandoned, and part B has committed the
   * terminal record: `starting` or `playing` to `finished`. Idempotent for the live attempt.
   */
  gameFinished(attemptId: string): TableResult {
    if (this.attempt?.attemptId !== attemptId) return refuse('staleAttempt');
    if (this.phase === 'finished') return ok([]);
    if (this.phase !== 'starting' && this.phase !== 'playing') return refuse('wrongPhase');
    this.phase = 'finished';
    this.finishedAt = this.now();
    return ok(this.broadcastState());
  }

  /**
   * `finished` to `reaped` once the idle time has passed. An `open` table nobody is connected to
   * (its host left the lobby) is reaped after the same time, so it frees its registry slot. Seat
   * tokens stop working.
   */
  reapIfIdle(): TableResult<{ reaped: boolean }> {
    const since =
      this.phase === 'finished' ? this.finishedAt : this.phase === 'open' ? this.emptySince : null;
    if (since === null || this.now() - since < this.limits.finishedIdleMs) {
      return ok([], { reaped: false });
    }
    this.phase = 'reaped';
    const effects: TableEffect[] = [];
    for (const socketId of this.conns.keys()) {
      effects.push(sendTo(socketId, { type: 'tableClosed', payload: { reason: 'reaped' } }), {
        type: 'close',
        socketId,
        reason: 'reaped',
      });
    }
    this.conns.clear();
    this.claims.clear();
    for (const record of this.seats.values()) record.player = null;
    return ok(effects, { reaped: true });
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────

  private register(conn: Connection): Conn {
    const record: Conn = {
      socketId: conn.socketId,
      address: conn.address,
      displayName: null,
      normalizedName: null,
      seat: null,
      isHost: false,
      capabilities: {},
    };
    this.conns.set(conn.socketId, record);
    this.emptySince = null;
    return record;
  }

  private removeConn(socketId: string): void {
    const conn = this.conns.get(socketId);
    if (conn === undefined) return;
    this.conns.delete(socketId);
    if (this.conns.size === 0) this.emptySince = this.now();
    for (const claim of [...this.claims.values()]) {
      if (claim.socketId === socketId) this.claims.delete(claim.claimId);
    }
    if (conn.seat !== null) {
      const player = this.seats.get(conn.seat)?.player;
      if (player !== null && player !== undefined && player.socketId === socketId) {
        player.socketId = null;
      }
    }
  }

  /** The seat becomes `open`; its token no longer opens anything. */
  private vacate(seat: PlayerId): void {
    const record = this.seats.get(seat);
    if (record === undefined) return;
    const player = record.player;
    if (player !== null && player.socketId !== null) {
      const conn = this.conns.get(player.socketId);
      if (conn !== undefined) conn.seat = null;
    }
    record.player = null;
    record.controller = 'open';
  }

  private dropClaimsFor(seat: PlayerId): void {
    for (const claim of [...this.claims.values()]) {
      if (claim.seat === seat) this.claims.delete(claim.claimId);
    }
  }

  /** Someone else already using this name once folded, or `null`. */
  private nameConflict(
    normalizedName: string,
    exceptSocketId: string,
  ): { displayName: string } | null {
    for (const conn of this.conns.values()) {
      if (conn.socketId !== exceptSocketId && conn.normalizedName === normalizedName) {
        return { displayName: conn.displayName ?? '' };
      }
    }
    for (const record of this.seats.values()) {
      if (
        record.player?.normalizedName === normalizedName &&
        record.player.socketId !== exceptSocketId
      ) {
        return { displayName: record.player.displayName };
      }
    }
    return null;
  }

  private versionMismatch(conn: Connection, clientVersion: number): Refused | null {
    if (clientVersion === PROTOCOL_VERSION) return null;
    return refuse('protocolMismatch', {
      effects: [
        sendTo(conn.socketId, {
          type: 'protocolMismatch',
          payload: { serverVersion: PROTOCOL_VERSION, clientVersion },
        }),
      ],
    });
  }

  /** Host messages need `hostAuth` on this connection, and the table `open`. */
  private hostGate(conn: Connection): Refused | null {
    if (this.conns.get(conn.socketId)?.isHost !== true) return refuse('notHost');
    if (this.phase !== 'open') return refuse('wrongPhase');
    return null;
  }

  private broadcastState(): TableEffect[] {
    const effects: TableEffect[] = [];
    for (const conn of this.conns.values()) {
      effects.push(sendTo(conn.socketId, this.stateMessage(conn)));
    }
    return effects;
  }

  private stateMessage(conn: Conn): TableServerToClientMessage {
    const blockers = this.startBlockers();
    const ownClaim = [...this.claims.values()].find((claim) => claim.socketId === conn.socketId);
    const payload: TableStatePayload = {
      tableId: this.id,
      phase: this.phase,
      seats: [...this.seats.values()].map((record) => ({
        seat: record.seat,
        controller: record.controller,
        displayName: record.player?.displayName ?? null,
        connected: record.player?.socketId != null,
      })),
      canStart: this.phase === 'open' && blockers.length === 0,
      startBlockers: blockers,
      insecureLan: this.insecureLan,
      clock: this.clock,
      modelSeats: this.modelSeats,
      you: {
        displayName: conn.displayName,
        seat: conn.seat,
        claim:
          ownClaim === undefined
            ? null
            : {
                claimId: ownClaim.claimId,
                seat: ownClaim.seat,
                verificationCode: ownClaim.verificationCode,
              },
        isHost: conn.isHost,
      },
    };
    if (conn.isHost) {
      payload.inviteCode = this.inviteCode;
      payload.pendingClaims = [...this.claims.values()].map((claim) => ({
        claimId: claim.claimId,
        seat: claim.seat,
        displayName: claim.displayName,
        verificationCode: claim.verificationCode,
      }));
    }
    return { type: 'tableState', payload };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

function sendTo(socketId: string, message: TableServerToClientMessage): TableEffect {
  return { type: 'send', socketId, message };
}

function ok<Extra extends object = object>(
  effects: TableEffect[],
  extra?: Extra,
): { ok: true; effects: TableEffect[] } & Extra {
  return { ok: true, effects, ...(extra ?? ({} as Extra)) };
}

type Refused = Extract<TableResult, { ok: false }>;

function refuse(
  reason: Refusal,
  extra: {
    effects?: TableEffect[];
    retryAfterMs?: number;
    lookalike?: boolean;
    blockers?: string[];
  } = {},
): Refused {
  return { ok: false, reason, effects: [], ...extra };
}
