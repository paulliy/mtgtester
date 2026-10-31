/**
 * The table's socket layer (ADR 0031 decisions 3, 5 and 6; plan M3 tasks 1, 3 and 5).
 *
 * It speaks the table message set only: the lobby and seat-resume messages of
 * `shared/src/table-protocol.ts`, the four in-game answers a seated player may send, and the
 * post-game `replayTurn`. Every other frame, the tester's messages included, is refused before
 * anything reads it further.
 *
 * Authority. A socket becomes a game socket only through a successful `resumeSeat`, which binds it
 * to `(table, seat, connection generation)`. Every in-game message is checked against that
 * binding before it is dispatched: the seat always comes from the binding and never from a
 * payload, the binding must be the seat's current one (a takeover supersedes the old socket at
 * once), and the table's own record must agree. Request ids and revisions are checked after that
 * and are never socket authority. A socket that only joined with the invite is lobby-only and
 * receives no player frame.
 *
 * Outbound. A game frame comes out of a `TableSessionPort` as `seatFrame` (one seat) or
 * `publicFrame` (every bound seat). Each frame is checked against the table policy's outbound
 * allowlist, then rewritten per recipient through `WireIds`: per-seat request ids and revisions,
 * per-viewer log sequences, and board snapshots only when that seat's projection changed. Output
 * carrying a generation other than the current attempt's is dropped.
 *
 * This module imports no Bun API: the server glue in `table-http.ts` adapts a `ServerWebSocket`
 * to `HubSocket`, so the hub is driven directly in tests.
 */

import {
  assertNever,
  isClientToServerMessage,
  parseStrictJson,
  parseTableClientFrame,
} from '@mtg/shared';
import type {
  ClientToServerMessage,
  GameResult,
  PlayerId,
  PresentationCue,
  ReplayUnlockedPayload,
  ServerToClientMessage,
  SpectatorState,
  TableClientToServerMessage,
  TableEnding,
  TableResultsPayload,
  TableServerToClientMessage,
} from '@mtg/shared';
import { isOutboundAllowed, tablePolicy, type DisclosurePolicy } from '../match/disclosure';
import { withoutActionData } from '../match/presentation';
import type {
  TableSessionConfig,
  TableSessionInput,
  TableSessionOutput,
  TableSessionPort,
  TableSetupProblems,
} from './session-port';
import type { TableRegistry } from './registry';
import type { Connection, Refusal, StartAttempt, TableEffect, TableResult, Table } from './table';
import { WireIds } from './wire-ids';

// ── Public types ────────────────────────────────────────────────────────────────────────────

/** One connected socket as the hub sees it. The Bun glue adapts a `ServerWebSocket` to this. */
export interface HubSocket {
  /** Unique per connection. */
  readonly id: string;
  /** The client address the throttles and per-address caps key on. */
  readonly address: string;
  send(text: string): void;
  close(): void;
}

/**
 * What the post-game view reads (`table/post-game.ts`). It is called only after the attempt's
 * port has stopped and its end has been committed, so nothing it returns can describe a game that
 * is still running.
 */
export interface PostGameReader {
  /** The post-game record and, when the game committed a log, the replay's unlock frame. */
  results(query: {
    tableId: string;
    attemptId: string;
    ending: TableEnding;
    result: GameResult | null;
  }): Promise<{ results: TableResultsPayload; unlock: ReplayUnlockedPayload | null }>;
  /** One committed turn of the finished game, or `null`. */
  turn(query: { tableId: string; attemptId: string; turn: number }): Promise<SpectatorState | null>;
}

/** How a start attempt ended, as the table database records it. */
export type AttemptEndStatus =
  'rejected' | 'finished' | 'setupFailed' | 'workerFailure' | 'hostAbandoned';

/** The timers the health watchdog uses; tests supply their own. */
export interface HealthTimers {
  now(): number;
  every(ms: number, tick: () => void): () => void;
}

export interface HealthOptions {
  /** How often a probe is sent. Plan default 5 seconds. */
  intervalMs: number;
  /** A worker is dead after this long without an answered probe. Plan default 30 seconds. */
  timeoutMs: number;
  timers?: HealthTimers;
}

export const DEFAULT_HEALTH: HealthOptions = { intervalMs: 5_000, timeoutMs: 30_000 };

export interface SocketLimits {
  /** A socket that has not joined, resumed a seat or authenticated as host by then is closed. */
  preAuthMs: number;
  /** Inbound frames per second a socket may send, in a burst of the same size. Above: closed. */
  messagesPerSecond: number;
  timers?: {
    now(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export const DEFAULT_SOCKET_LIMITS: SocketLimits = { preAuthMs: 10_000, messagesPerSecond: 20 };

const realSocketTimers = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const realTimers: HealthTimers = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const handle = setInterval(tick, ms);
    return () => {
      clearInterval(handle);
    };
  },
};

export interface TableWsDeps {
  registry: TableRegistry;
  /** One port per start attempt; the hub gives each a fresh generation number. */
  portFactory: (generation: number) => TableSessionPort;
  /**
   * Turns an approved start attempt into the port's configuration (and persists the private
   * start-attempt manifest first). A throw or rejection fails the attempt as `setupFailed`.
   */
  buildConfig: (
    attempt: StartAttempt,
    generation: number,
  ) => TableSessionConfig | Promise<TableSessionConfig>;
  /** The host approved a claim: store the deck under a table-scoped id. Failures are ignored. */
  onDeckApproved?: (
    tableId: string,
    approved: { seat: PlayerId; displayName: string; decklist: string },
  ) => void | Promise<void>;
  postGame?: PostGameReader;
  /**
   * Commit how an attempt ended (the table database's attempt row, and a still-running game row
   * closed as a halt for an interruption). Awaited after the port has stopped and before anything
   * post-game is unlocked. A failure is ignored: the attempt has ended either way.
   */
  onAttemptEnded?: (
    attempt: { tableId: string; attemptId: string },
    status: AttemptEndStatus,
  ) => void | Promise<void>;
  /** Worker health probes. Omit to probe nothing (the in-process port is always reachable). */
  health?: HealthOptions;
  /** Per-socket limits (plan M5 task 2). Defaults to `DEFAULT_SOCKET_LIMITS`. */
  socketLimits?: SocketLimits;
  /** The table's disclosure policy. Defaults to `tablePolicy()`. */
  policy?: Readonly<DisclosurePolicy>;
}

export interface TableWsStats {
  /** Outbound frames the table policy's allowlist refused. */
  droppedByPolicy: number;
  /** Port outputs whose generation was not the current attempt's, or that came after its end. */
  droppedStale: number;
  /** Seat frames with no socket currently bound to the seat. */
  droppedUnbound: number;
  /** Attempts ended because their worker stopped answering health probes. */
  unhealthy: number;
  /** Sockets closed for not authenticating in time. */
  preAuthClosed: number;
  /** Sockets closed for sending frames too fast. */
  rateClosed: number;
}

// ── Fixed texts ─────────────────────────────────────────────────────────────────────────────

/** One fixed sentence per refusal: nothing from the request is quoted back. */
const REFUSAL_TEXT: Record<Refusal, string> = {
  wrongPhase: 'That is not possible at this stage of the table.',
  protocolMismatch: 'This client is out of date. Reload the page.',
  throttled: 'Too many attempts. Wait a moment and try again.',
  badInvite: 'That invite code is not valid.',
  badToken: 'That token is not valid.',
  notJoined: 'Join the table first.',
  notHost: 'Only the host can do that.',
  alreadyJoined: 'You have already joined this table.',
  badName: 'Choose a different display name.',
  nameTaken: 'That name is taken. Choose another.',
  tableFull: 'This table is full.',
  unknownSeat: 'There is no such seat.',
  seatUnavailable: 'That seat is not open.',
  alreadySeated: 'You already hold a seat.',
  claimLimitTable: 'Too many seat requests are waiting on the host.',
  claimLimitSocket: 'You already have a seat request waiting.',
  claimLimitAddress: 'Too many seat requests from this address are waiting.',
  deckInvalid: 'That decklist cannot be used.',
  unknownClaim: 'That seat request is no longer pending.',
  noSeat: 'You hold no seat or seat request.',
  noPlayer: 'Nobody holds that seat.',
  cannotStart: 'The table cannot start yet.',
  staleAttempt: 'That start attempt is no longer current.',
  alreadyAbandoning: 'The game is already being ended.',
};

const UNRECOGNISED = 'Unrecognised message.';
const NO_SEAT = 'This connection holds no seat.';
const FRAME_TOO_LARGE = 'Message too large.';
const INTERRUPTED_TEXT = {
  setupFailed: 'The game could not be started.',
  workerFailure: 'The game was interrupted by a server fault.',
  hostAbandoned: 'The host ended the game.',
} as const;

/** The largest inbound frame accepted, in UTF-16 code units. */
export const TABLE_MAX_FRAME_CHARS = 256 * 1024;

/** The in-game answers a seated player may send. Everything else of the tester's set is refused. */
const IN_GAME_TYPES = [
  'submitPlayerAction',
  'yieldPlayerAbility',
  'resumePlayerAbility',
  'cancelYield',
] as const;
type InGameType = (typeof IN_GAME_TYPES)[number];
type InGameMessage = Extract<ClientToServerMessage, { type: InGameType }>;

const isInGameMessage = (message: ClientToServerMessage): message is InGameMessage =>
  (IN_GAME_TYPES as readonly string[]).includes(message.type);

// ── Internal records ────────────────────────────────────────────────────────────────────────

/** Who a game socket is, fixed at `resumeSeat` and checked before every in-game dispatch. */
interface Binding {
  tableId: string;
  seat: PlayerId;
  /** The seat's connection generation when this socket bound; superseded by the next bind. */
  generation: number;
  /** The key of this socket's log sequence counter. A new binding counts from 0. */
  viewer: string;
}

/** What one seat was last shown, so its answer can be translated and its error echoes mapped. */
interface PendingDecision {
  engineRequestId: string;
  wireRequestId: string;
  engineRevision: number;
  /** The revision sent with the decision frame; the answer is checked against it. */
  wireRevision: number;
}

interface LastSubmit {
  engineRequestId: string;
  wireRequestId: string;
  wireRevision: number;
}

/** One start attempt: a port, its generation, and the per-seat wire state of its game. */
interface AttemptRun {
  attemptId: string;
  generation: number;
  port: TableSessionPort | null;
  /** The seats a person plays; a seat with no bound socket when the game starts is away. */
  humanSeats: PlayerId[];
  unsubscribe: (() => void) | null;
  /** Set by the first terminal transition, which wins over any racing result or timeout. */
  terminal: boolean;
  started: boolean;
  wire: WireIds;
  pending: Map<PlayerId, PendingDecision>;
  lastSubmit: Map<PlayerId, LastSubmit>;
  /** Stops the health watchdog; null when none runs. */
  stopHealth: (() => void) | null;
}

/** The finished attempt the post-game view describes. */
interface Ended {
  attemptId: string;
  /** Null until the reader answered; then what every seat socket is sent. */
  view: { results: TableResultsPayload; unlock: ReplayUnlockedPayload | null } | null;
}

interface TableRuntime {
  table: Table;
  sockets: Map<string, HubSocket>;
  bindings: Map<string, Binding>;
  /** The socket currently bound to each seat. */
  seatSockets: Map<PlayerId, string>;
  seatGenerations: Map<PlayerId, number>;
  nextGeneration: number;
  run: AttemptRun | null;
  ended: Ended | null;
}

type Outcome =
  | { kind: 'gameOver'; result: GameResult }
  | { kind: 'rejected'; problems: TableSetupProblems }
  | { kind: 'failed'; reason: 'setupFailed' | 'workerFailure' | 'hostAbandoned' };

const errorFrame = (
  message: string,
  correlation?: { requestId: string; revision: number },
): ServerToClientMessage => ({
  type: 'error',
  payload: { message, ...(correlation ?? {}) },
});

/**
 * A batch's cues in this viewer's log numbering: each takes the per-viewer sequence of the first
 * line at or after its event (its own line, or the next this viewer was shown), and a cue past
 * the viewer's last line takes that line. Rebuilt field by field, so nothing else rides along.
 */
function wireCues(
  cues: readonly PresentationCue[],
  lines: ReadonlyArray<{ engine: number; line: { sequence: number } }>,
): PresentationCue[] {
  const last = lines.at(-1);
  if (last === undefined) return [];
  const wireSequence = (engine: number): number =>
    (lines.find((entry) => entry.engine >= engine) ?? last).line.sequence;
  return cues.map((cue): PresentationCue => {
    switch (cue.kind) {
      case 'damage':
        return {
          kind: 'damage',
          sequence: wireSequence(cue.sequence),
          sourceId: cue.sourceId,
          target:
            cue.target.kind === 'object'
              ? { kind: 'object', id: cue.target.id }
              : { kind: 'player', id: cue.target.id },
          amount: cue.amount,
          combat: cue.combat,
          group: cue.group,
        };
      case 'lifeChange':
        return {
          kind: 'lifeChange',
          sequence: wireSequence(cue.sequence),
          player: cue.player,
          delta: cue.delta,
        };
      default:
        return assertNever(cue, 'presentation cue');
    }
  });
}

// ── The hub ─────────────────────────────────────────────────────────────────────────────────

export class TableSocketHub {
  private readonly runtimes = new Map<string, TableRuntime>();
  private readonly socketTables = new Map<string, string>();
  private readonly policy: Readonly<DisclosurePolicy>;
  private readonly counters: TableWsStats = {
    droppedByPolicy: 0,
    droppedStale: 0,
    droppedUnbound: 0,
    unhealthy: 0,
    preAuthClosed: 0,
    rateClosed: 0,
  };
  private readonly limits: SocketLimits;
  /** Set by `shutdown`: no socket opens and no game starts after it. */
  private closing = false;
  /** Per socket: its pre-authentication timer (null once authenticated) and its rate bucket. */
  private readonly guards = new Map<
    string,
    { preAuth: unknown; tokens: number; refilledAt: number }
  >();

  constructor(private readonly deps: TableWsDeps) {
    this.policy = deps.policy ?? tablePolicy();
    this.limits = deps.socketLimits ?? DEFAULT_SOCKET_LIMITS;
  }

  private get timers(): NonNullable<SocketLimits['timers']> {
    return this.limits.timers ?? realSocketTimers;
  }

  get stats(): Readonly<TableWsStats> {
    return { ...this.counters };
  }

  // ── Socket lifecycle ──────────────────────────────────────────────────────────────────────

  /** A socket opened on `/tables/<tableId>/ws`. False when no such table exists. */
  open(tableId: string, socket: HubSocket): boolean {
    if (this.closing) return false;
    const runtime = this.runtimeFor(tableId);
    if (runtime === null) return false;
    runtime.sockets.set(socket.id, socket);
    this.socketTables.set(socket.id, tableId);
    const preAuth = this.timers.setTimeout(() => {
      const guard = this.guards.get(socket.id);
      if (guard === undefined || guard.preAuth === null) return;
      this.counters.preAuthClosed += 1;
      this.sendTo(runtime, socket.id, errorFrame('Join the table first.'));
      this.closeSocket(runtime, socket.id);
      this.close(socket.id);
    }, this.limits.preAuthMs);
    this.guards.set(socket.id, {
      preAuth,
      tokens: this.limits.messagesPerSecond,
      refilledAt: this.timers.now(),
    });
    return true;
  }

  /** The socket proved itself: it joined, resumed a seat or authenticated as host. */
  private authenticated(socketId: string): void {
    const guard = this.guards.get(socketId);
    if (guard === undefined || guard.preAuth === null) return;
    this.timers.clearTimeout(guard.preAuth);
    guard.preAuth = null;
  }

  /** Take one frame from the socket's bucket; false when it is sending too fast. */
  private withinRate(socketId: string): boolean {
    const guard = this.guards.get(socketId);
    if (guard === undefined) return true;
    const now = this.timers.now();
    const rate = this.limits.messagesPerSecond;
    guard.tokens = Math.min(rate, guard.tokens + ((now - guard.refilledAt) / 1000) * rate);
    guard.refilledAt = now;
    if (guard.tokens < 1) return false;
    guard.tokens -= 1;
    return true;
  }

  private dropGuard(socketId: string): void {
    const guard = this.guards.get(socketId);
    if (guard?.preAuth !== null && guard?.preAuth !== undefined) {
      this.timers.clearTimeout(guard.preAuth);
    }
    this.guards.delete(socketId);
  }

  close(socketId: string): void {
    this.dropGuard(socketId);
    const tableId = this.socketTables.get(socketId);
    this.socketTables.delete(socketId);
    const runtime = tableId === undefined ? undefined : this.runtimes.get(tableId);
    if (runtime === undefined) return;
    const socket = runtime.sockets.get(socketId);
    runtime.sockets.delete(socketId);
    this.unbind(runtime, socketId);
    if (socket !== undefined) {
      this.apply(runtime, runtime.table.disconnect(socketId).effects);
    }
  }

  /** One inbound text frame. */
  message(socketId: string, text: string): void {
    const tableId = this.socketTables.get(socketId);
    const runtime = tableId === undefined ? undefined : this.runtimes.get(tableId);
    const socket = runtime?.sockets.get(socketId);
    if (runtime === undefined || socket === undefined) return;
    if (!this.withinRate(socketId)) {
      this.counters.rateClosed += 1;
      this.closeSocket(runtime, socketId);
      // Forget it now: anything else it sent before the close lands is not read.
      this.close(socketId);
      return;
    }
    if (text.length > TABLE_MAX_FRAME_CHARS) {
      this.sendTo(runtime, socketId, errorFrame(FRAME_TOO_LARGE));
      return;
    }
    const parsed = parseTableClientFrame(text);
    if (parsed.ok) {
      this.dispatchTable(runtime, socket, parsed.message);
      return;
    }
    if (parsed.reason !== 'unknownType') {
      this.sendTo(runtime, socketId, errorFrame(UNRECOGNISED));
      return;
    }
    // Not a table message: only the four in-game answers are accepted from the tester's set.
    const strict = parseStrictJson(text);
    const value: unknown = strict.ok ? strict.value : null;
    if (!isClientToServerMessage(value) || !isInGameMessage(value)) {
      this.sendTo(runtime, socketId, errorFrame(UNRECOGNISED));
      return;
    }
    this.dispatchInGame(runtime, socketId, value);
  }

  /** Reap finished tables that have been idle long enough. Called by the timer the server owns. */
  reapIdle(): void {
    for (const { tableId, effects } of this.deps.registry.reapIdle()) {
      const runtime = this.runtimes.get(tableId);
      if (runtime === undefined) continue;
      this.apply(runtime, effects);
      const run = runtime.run;
      runtime.run = null;
      if (run !== null) {
        run.terminal = true;
        run.unsubscribe?.();
        run.stopHealth?.();
        void this.terminateQuiet(run.port, 'workerFailure');
      }
      // A socket that never joined has no connection record, so the table's effects missed it.
      for (const socketId of [...runtime.sockets.keys()]) {
        this.closeSocket(runtime, socketId);
        this.socketTables.delete(socketId);
        this.dropGuard(socketId);
      }
      this.runtimes.delete(tableId);
    }
  }

  /**
   * Stop every running game and close every socket (server shutdown). Nothing new opens or
   * starts once this is called. Each live game ends through the normal path as `workerFailure`,
   * so its attempt and game rows are closed before the sockets go.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const socketId of [...this.guards.keys()]) this.dropGuard(socketId);
    const ends: Promise<void>[] = [];
    for (const runtime of this.runtimes.values()) {
      const run = runtime.run;
      if (run !== null) {
        ends.push(this.settle(runtime, run, { kind: 'failed', reason: 'workerFailure' }));
      }
    }
    await Promise.all(ends);
    for (const runtime of this.runtimes.values()) {
      for (const socket of runtime.sockets.values()) {
        try {
          socket.close();
        } catch {
          // already closed
        }
      }
    }
  }

  // ── Table messages ────────────────────────────────────────────────────────────────────────

  private dispatchTable(
    runtime: TableRuntime,
    socket: HubSocket,
    message: TableClientToServerMessage,
  ): void {
    const table = runtime.table;
    const conn: Connection = { socketId: socket.id, address: socket.address };
    switch (message.type) {
      case 'joinTable': {
        const result = table.join(conn, message.payload);
        if (result.ok) this.authenticated(socket.id);
        this.finish(runtime, socket, result);
        return;
      }
      case 'requestSeat':
        this.finish(runtime, socket, table.requestSeat(conn, message.payload));
        return;
      case 'leaveSeat':
        this.finish(runtime, socket, table.leaveSeat(conn));
        return;
      case 'hostAuth': {
        const result = table.hostAuth(conn, message.payload);
        if (result.ok) this.authenticated(socket.id);
        this.finish(runtime, socket, result);
        return;
      }
      case 'hostApprove':
        this.finish(runtime, socket, table.hostApprove(conn, message.payload));
        return;
      case 'hostDeny':
        this.finish(runtime, socket, table.hostDeny(conn, message.payload));
        return;
      case 'hostSetSeat':
        this.finish(runtime, socket, table.hostSetSeat(conn, message.payload));
        return;
      case 'hostKick': {
        const result = table.hostKick(conn, message.payload);
        this.finish(runtime, socket, result);
        return;
      }
      case 'hostRotateInvite':
        this.finish(runtime, socket, table.hostRotateInvite(conn));
        return;
      case 'hostStart':
        if (this.closing) {
          this.sendTo(runtime, socket.id, errorFrame('The server is shutting down.'));
          return;
        }
        this.finish(runtime, socket, table.hostStart(conn));
        return;
      case 'hostAbandon':
        this.finish(runtime, socket, table.hostAbandon(conn));
        return;
      case 'resumeSeat': {
        const result = table.resumeSeat(conn, message.payload);
        // Bind before the effects run, so the socket the table closes is already superseded.
        if (result.ok) {
          this.authenticated(socket.id);
          this.bindSeat(runtime, socket.id, result.seat);
        }
        this.finish(runtime, socket, result);
        return;
      }
      case 'resumeControl': {
        // Only the socket currently bound to the seat may take it back (M4 task 5).
        const seat = this.boundSeat(runtime, socket.id);
        const run = runtime.run;
        if (seat === null || run === null || run.terminal || !run.started) {
          this.sendTo(runtime, socket.id, errorFrame(NO_SEAT));
          return;
        }
        this.toPort(run, { type: 'resumeControl', seat });
        return;
      }
      case 'replayTurn':
        void this.replay(runtime, socket.id, message.payload.turn);
        return;
      default:
        assertNever(message, 'table client message');
    }
  }

  /** Carry out a result's effects, and tell the caller why if the table refused. */
  private finish(runtime: TableRuntime, socket: HubSocket, result: TableResult): void {
    this.apply(runtime, result.effects);
    if (result.ok) return;
    // `protocolMismatch` and `deckInvalid` already answered through their own effects.
    if (result.reason === 'protocolMismatch' || result.reason === 'deckInvalid') return;
    let text = REFUSAL_TEXT[result.reason];
    if (result.reason === 'nameTaken' && result.lookalike === true) {
      text = 'That name is too close to one already at the table.';
    }
    if (result.reason === 'cannotStart' && result.blockers !== undefined) {
      text = `The table cannot start yet. ${result.blockers.join(' ')}`;
    }
    this.sendTo(runtime, socket.id, errorFrame(text));
  }

  private apply(runtime: TableRuntime, effects: readonly TableEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'send':
          this.sendTo(runtime, effect.socketId, effect.message);
          break;
        case 'close':
          this.closeSocket(runtime, effect.socketId);
          break;
        case 'startGame':
          void this.startAttempt(runtime, effect.attempt);
          break;
        case 'abandonGame':
          void this.abandonAttempt(runtime, effect.attemptId);
          break;
        case 'deckApproved':
          this.deckApproved(runtime, effect);
          break;
        default:
          assertNever(effect, 'table effect');
      }
    }
  }

  private deckApproved(
    runtime: TableRuntime,
    effect: Extract<TableEffect, { type: 'deckApproved' }>,
  ): void {
    const hook = this.deps.onDeckApproved;
    if (hook === undefined) return;
    void Promise.resolve()
      .then(() =>
        hook(runtime.table.id, {
          seat: effect.seat,
          displayName: effect.displayName,
          decklist: effect.decklist,
        }),
      )
      .catch(() => undefined);
  }

  // ── Socket binding ────────────────────────────────────────────────────────────────────────

  /** Bind `socketId` to `seat` under a new connection generation, superseding any holder. */
  private bindSeat(runtime: TableRuntime, socketId: string, seat: PlayerId): void {
    const previous = runtime.seatSockets.get(seat);
    if (previous !== undefined && previous !== socketId) runtime.bindings.delete(previous);
    const own = runtime.bindings.get(socketId);
    if (own !== undefined && own.seat !== seat) {
      // One seat per socket: the seat it held is released, and its player is away.
      if (runtime.seatSockets.get(own.seat) === socketId) {
        runtime.seatSockets.delete(own.seat);
        this.notifyConnected(runtime, own.seat, false);
      }
    }
    const generation = (runtime.seatGenerations.get(seat) ?? 0) + 1;
    runtime.seatGenerations.set(seat, generation);
    runtime.bindings.set(socketId, {
      tableId: runtime.table.id,
      seat,
      generation,
      viewer: `${seat}#${generation}`,
    });
    runtime.seatSockets.set(seat, socketId);
    const run = runtime.run;
    if (run !== null && run.started && !run.terminal) this.attachSeat(runtime, run, seat);
    if (this.isTerminal(runtime)) this.sendPostGame(runtime, socketId);
  }

  /** A socket went away or was closed by the table: drop its binding if it is still current. */
  private unbind(runtime: TableRuntime, socketId: string): void {
    const binding = runtime.bindings.get(socketId);
    if (binding === undefined) return;
    runtime.bindings.delete(socketId);
    if (runtime.seatSockets.get(binding.seat) === socketId) {
      runtime.seatSockets.delete(binding.seat);
      this.notifyConnected(runtime, binding.seat, false);
    }
  }

  /** Drop bindings the table no longer agrees with (a seat vacated by a rejected start). */
  private reconcileBindings(runtime: TableRuntime): void {
    for (const [socketId, binding] of [...runtime.bindings]) {
      if (runtime.table.seatOfSocket(socketId) !== binding.seat) {
        runtime.bindings.delete(socketId);
        if (runtime.seatSockets.get(binding.seat) === socketId) {
          runtime.seatSockets.delete(binding.seat);
        }
      }
    }
  }

  /**
   * The seat this socket may act for right now, or `null`. All of: it holds the seat's current
   * binding, the seat's generation has not moved on, and the table agrees. The seat comes from
   * here and from nowhere else.
   */
  private boundSeat(runtime: TableRuntime, socketId: string): PlayerId | null {
    const binding = runtime.bindings.get(socketId);
    if (binding === undefined || binding.tableId !== runtime.table.id) return null;
    if (runtime.seatSockets.get(binding.seat) !== socketId) return null;
    if (runtime.seatGenerations.get(binding.seat) !== binding.generation) return null;
    if (runtime.table.seatOfSocket(socketId) !== binding.seat) return null;
    return binding.seat;
  }

  private closeSocket(runtime: TableRuntime, socketId: string): void {
    this.unbind(runtime, socketId);
    try {
      runtime.sockets.get(socketId)?.close();
    } catch {
      // already closed
    }
  }

  // ── In-game messages ──────────────────────────────────────────────────────────────────────

  private dispatchInGame(runtime: TableRuntime, socketId: string, message: InGameMessage): void {
    const seat = this.boundSeat(runtime, socketId);
    const run = runtime.run;
    const correlated =
      message.type === 'submitPlayerAction'
        ? { requestId: message.payload.requestId, revision: message.payload.revision }
        : undefined;
    if (seat === null || run === null || run.terminal || runtime.table.currentPhase !== 'playing') {
      this.sendTo(runtime, socketId, errorFrame(NO_SEAT, correlated));
      return;
    }
    switch (message.type) {
      case 'submitPlayerAction': {
        const payload = message.payload;
        const pending = this.matchPending(run, seat, payload.requestId, payload.revision);
        if (typeof pending === 'string') {
          this.sendTo(
            runtime,
            socketId,
            errorFrame(pending, { requestId: payload.requestId, revision: payload.revision }),
          );
          return;
        }
        run.lastSubmit.set(seat, {
          engineRequestId: pending.engineRequestId,
          wireRequestId: pending.wireRequestId,
          wireRevision: pending.wireRevision,
        });
        this.toPort(run, {
          type: 'submitPlayerAction',
          seat,
          payload: {
            requestId: pending.engineRequestId,
            revision: pending.engineRevision,
            actionId: payload.actionId,
            ...(payload.targets === undefined ? {} : { targets: payload.targets }),
          },
        });
        return;
      }
      case 'yieldPlayerAbility': {
        const payload = message.payload;
        const pending = this.matchPending(run, seat, payload.requestId, payload.revision);
        if (typeof pending === 'string') {
          this.sendTo(runtime, socketId, errorFrame(pending));
          return;
        }
        this.toPort(run, {
          type: 'yieldPlayerAbility',
          seat,
          payload: {
            requestId: pending.engineRequestId,
            revision: pending.engineRevision,
            actionId: payload.actionId,
            ...(payload.mode === undefined ? {} : { mode: payload.mode }),
          },
        });
        return;
      }
      case 'resumePlayerAbility':
        this.toPort(run, { type: 'resumePlayerAbility', seat, key: message.payload.key });
        return;
      case 'cancelYield':
        this.toPort(run, { type: 'cancelYield', seat });
        return;
      default:
        assertNever(message, 'in-game message');
    }
  }

  /**
   * The decision this wire id and revision answer, or a short reason it does not. The wire id
   * must be one this seat was shown, it must be the seat's pending decision, and the revision
   * must be the one sent with that decision.
   */
  private matchPending(
    run: AttemptRun,
    seat: PlayerId,
    wireRequestId: string,
    wireRevision: number,
  ): PendingDecision | string {
    const pending = run.pending.get(seat);
    const engineId = run.wire.toEngineId(seat, wireRequestId);
    if (pending === undefined || engineId === undefined || engineId !== pending.engineRequestId) {
      return 'That decision is stale.';
    }
    if (wireRevision !== pending.wireRevision) return 'The board changed; choose again.';
    return pending;
  }

  private toPort(run: AttemptRun, input: TableSessionInput): void {
    const port = run.port;
    if (port === null) return;
    // A dead worker is found by the health probe, not here.
    void port.send(input).catch(() => undefined);
  }

  /** Tell the game a seat's socket is connected, with its capability, and re-send its view. */
  private attachSeat(runtime: TableRuntime, run: AttemptRun, seat: PlayerId): void {
    const socketId = runtime.seatSockets.get(seat);
    const port = run.port;
    if (socketId === undefined || port === null) return;
    const raw = runtime.table.capabilitiesOf(socketId)?.rawActionData === true;
    run.wire.invalidateBoard(seat);
    void (async () => {
      await port.send({ type: 'setRawActionData', seat, enabled: raw });
      await port.send({ type: 'setPlayerConnected', seat, connected: true });
      await port.send({ type: 'resyncPlayer', seat });
    })().catch(() => undefined);
  }

  private notifyConnected(runtime: TableRuntime, seat: PlayerId, connected: boolean): void {
    const run = runtime.run;
    if (run === null || !run.started || run.terminal || run.port === null) return;
    void run.port.send({ type: 'setPlayerConnected', seat, connected }).catch(() => undefined);
  }

  // ── Replay ────────────────────────────────────────────────────────────────────────────────

  private async replay(runtime: TableRuntime, socketId: string, turn: number): Promise<void> {
    if (runtime.table.currentPhase !== 'finished') {
      this.sendTo(runtime, socketId, errorFrame('Replay unlocks when the game is over.'));
      return;
    }
    const seat = this.boundSeat(runtime, socketId);
    if (seat === null) {
      this.sendTo(runtime, socketId, errorFrame(NO_SEAT));
      return;
    }
    const reader = this.deps.postGame;
    const ended = runtime.ended;
    let state: SpectatorState | null = null;
    try {
      state =
        reader === undefined || ended === null
          ? null
          : await reader.turn({ tableId: runtime.table.id, attemptId: ended.attemptId, turn });
    } catch {
      state = null;
    }
    // The phase may have changed while the reader ran; the seat's binding may have too.
    if (state === null || this.boundSeat(runtime, socketId) !== seat) {
      this.sendTo(runtime, socketId, errorFrame('That turn is not in the replay.'));
      return;
    }
    this.sendGated(runtime, socketId, { type: 'replayTurnState', payload: { turn, state } });
  }

  /** The post-game frames, to one socket, once they exist. Each is held to the policy. */
  private sendPostGame(runtime: TableRuntime, socketId: string): void {
    const view = runtime.ended?.view;
    if (view === undefined || view === null) return;
    if (view.unlock !== null) {
      this.sendGated(runtime, socketId, { type: 'replayUnlocked', payload: view.unlock });
    }
    this.sendGated(runtime, socketId, { type: 'tableResults', payload: view.results });
  }

  /** Send a full-state frame only if the policy allows it now. */
  private sendGated(
    runtime: TableRuntime,
    socketId: string,
    message: TableServerToClientMessage | ServerToClientMessage,
  ): void {
    if (!isOutboundAllowed(this.policy, message.type, { terminal: this.isTerminal(runtime) })) {
      this.counters.droppedByPolicy += 1;
      return;
    }
    this.sendTo(runtime, socketId, message);
  }

  /** Read the post-game view once the end is committed, and send it to every seated socket. */
  private async unlockPostGame(
    runtime: TableRuntime,
    attemptId: string,
    ending: TableEnding,
    result: GameResult | null,
  ): Promise<void> {
    const ended: Ended = { attemptId, view: null };
    runtime.ended = ended;
    const reader = this.deps.postGame;
    if (reader === undefined) return;
    try {
      ended.view = await reader.results({ tableId: runtime.table.id, attemptId, ending, result });
    } catch {
      return;
    }
    if (runtime.ended !== ended || !this.isTerminal(runtime)) return;
    for (const [seat, socketId] of runtime.seatSockets) {
      if (this.boundSeat(runtime, socketId) === seat) this.sendPostGame(runtime, socketId);
    }
  }

  // ── Start, outputs and the end of an attempt ──────────────────────────────────────────────

  private async startAttempt(runtime: TableRuntime, attempt: StartAttempt): Promise<void> {
    const generation = runtime.nextGeneration + 1;
    runtime.nextGeneration = generation;
    const run: AttemptRun = {
      attemptId: attempt.attemptId,
      generation,
      port: null,
      humanSeats: attempt.seats.flatMap((seat) => (seat.controller === 'human' ? [seat.seat] : [])),
      unsubscribe: null,
      terminal: false,
      started: false,
      wire: new WireIds(),
      pending: new Map(),
      lastSubmit: new Map(),
      stopHealth: null,
    };
    runtime.run = run;
    runtime.ended = null;
    try {
      const port = this.deps.portFactory(generation);
      run.port = port;
      run.unsubscribe = port.onOutput((output) => this.onOutput(runtime, run, output));
      this.watchHealth(runtime, run, port);
      const config = await this.deps.buildConfig(attempt, generation);
      if (run.terminal) return;
      await port.start(config);
    } catch {
      await this.settle(runtime, run, { kind: 'failed', reason: 'setupFailed' });
    }
  }

  /**
   * Probe the port on a fixed interval, independently of game progress. An unanswered probe
   * older than the timeout ends the attempt: the port is stopped (which stops a blocked thread)
   * and the attempt fails as `setupFailed` before the game started, `workerFailure` after.
   * Probes never reach a player and never move a seat's revision.
   */
  private watchHealth(runtime: TableRuntime, run: AttemptRun, port: TableSessionPort): void {
    const health = this.deps.health;
    if (health === undefined) return;
    const timers = health.timers ?? realTimers;
    let lastAnswer = timers.now();
    let outstanding = false;
    run.stopHealth = timers.every(health.intervalMs, () => {
      if (run.terminal) {
        run.stopHealth?.();
        return;
      }
      if (timers.now() - lastAnswer >= health.timeoutMs) {
        this.counters.unhealthy += 1;
        void this.settle(runtime, run, {
          kind: 'failed',
          reason: run.started ? 'workerFailure' : 'setupFailed',
        });
        return;
      }
      if (outstanding) return;
      outstanding = true;
      port.ping().then(
        () => {
          outstanding = false;
          lastAnswer = timers.now();
        },
        () => {
          // A port that cannot be probed is left to age out against the timeout.
        },
      );
    });
  }

  private async abandonAttempt(runtime: TableRuntime, attemptId: string): Promise<void> {
    const run = runtime.run;
    if (run === null || run.attemptId !== attemptId || run.terminal) return;
    await this.terminateQuiet(run.port, 'hostAbandoned');
    // The port reports `hostAbandoned` itself; settle here only if it did not.
    await this.settle(runtime, run, { kind: 'failed', reason: 'hostAbandoned' });
  }

  private onOutput(runtime: TableRuntime, run: AttemptRun, output: TableSessionOutput): void {
    if (output.generation !== run.generation || runtime.run !== run || run.terminal) {
      this.counters.droppedStale += 1;
      return;
    }
    switch (output.type) {
      case 'started': {
        if (run.started) return;
        run.started = true;
        const result = runtime.table.startSucceeded(run.attemptId);
        this.apply(runtime, result.effects);
        for (const seat of [...runtime.seatSockets.keys()]) this.attachSeat(runtime, run, seat);
        // A seat whose player never bound a socket (a tab closed during setup) starts away, so
        // its clock waits and the all-away check counts it.
        for (const seat of run.humanSeats) {
          if (!runtime.seatSockets.has(seat)) {
            this.toPort(run, { type: 'setPlayerConnected', seat, connected: false });
          }
        }
        return;
      }
      case 'seatFrame':
        this.deliver(runtime, run, [output.seat], output.message);
        return;
      case 'publicFrame':
        this.deliver(runtime, run, [...runtime.seatSockets.keys()], output.message);
        return;
      case 'tableFrame':
        for (const [seat, socketId] of runtime.seatSockets) {
          if (this.boundSeat(runtime, socketId) === seat) {
            this.sendGated(runtime, socketId, output.message);
          }
        }
        return;
      case 'setupProblems':
        void this.settle(runtime, run, { kind: 'rejected', problems: output.problems });
        return;
      case 'gameOver':
        void this.settle(runtime, run, { kind: 'gameOver', result: output.result });
        return;
      case 'failed':
        void this.settle(runtime, run, { kind: 'failed', reason: output.reason });
        return;
      default:
        assertNever(output, 'session output');
    }
  }

  /**
   * End the attempt, once. The first terminal transition wins: later ones, and every later
   * output, are ignored. The port is stopped and awaited before the table is told, so a game
   * that is still running is never unlocked.
   */
  private async settle(runtime: TableRuntime, run: AttemptRun, outcome: Outcome): Promise<void> {
    if (run.terminal) return;
    run.terminal = true;
    run.unsubscribe?.();
    run.stopHealth?.();
    const stopReason = outcome.kind === 'failed' ? outcome.reason : 'workerFailure';
    await this.terminateQuiet(
      run.port,
      stopReason === 'hostAbandoned' ? 'hostAbandoned' : 'workerFailure',
    );
    if (runtime.run !== run) return; // the table was reaped meanwhile
    const status: AttemptEndStatus =
      outcome.kind === 'rejected'
        ? 'rejected'
        : outcome.kind === 'gameOver'
          ? 'finished'
          : outcome.reason;
    await this.commitEnd(runtime, run.attemptId, status);
    if (runtime.run !== run) return;
    const table = runtime.table;
    switch (outcome.kind) {
      case 'rejected': {
        runtime.run = null;
        const result = table.startRejected(run.attemptId, outcome.problems);
        this.apply(runtime, result.effects);
        this.reconcileBindings(runtime);
        return;
      }
      case 'gameOver': {
        this.apply(runtime, table.gameFinished(run.attemptId).effects);
        await this.unlockPostGame(runtime, run.attemptId, 'gameOver', outcome.result);
        return;
      }
      case 'failed': {
        // A fixed line for everyone at the table; the interrupted game has no result to show.
        const text = INTERRUPTED_TEXT[outcome.reason];
        for (const socketId of runtime.sockets.keys()) {
          this.sendTo(runtime, socketId, errorFrame(text));
        }
        this.apply(runtime, table.gameFinished(run.attemptId).effects);
        await this.unlockPostGame(runtime, run.attemptId, outcome.reason, null);
        return;
      }
      default:
        assertNever(outcome, 'attempt outcome');
    }
  }

  private async commitEnd(
    runtime: TableRuntime,
    attemptId: string,
    status: AttemptEndStatus,
  ): Promise<void> {
    const hook = this.deps.onAttemptEnded;
    if (hook === undefined) return;
    try {
      await hook({ tableId: runtime.table.id, attemptId }, status);
    } catch {
      // The attempt has ended either way; the table must not be stranded in `playing`.
    }
  }

  private async terminateQuiet(
    port: TableSessionPort | null,
    reason: 'workerFailure' | 'hostAbandoned',
  ): Promise<void> {
    if (port === null) return;
    try {
      await port.terminate(reason);
    } catch {
      // The attempt ends either way.
    }
  }

  // ── Outbound frames ───────────────────────────────────────────────────────────────────────

  private isTerminal(runtime: TableRuntime): boolean {
    return runtime.table.currentPhase === 'finished';
  }

  /** Send one game frame to each listed seat's current socket, after policy and wire rewriting. */
  private deliver(
    runtime: TableRuntime,
    run: AttemptRun,
    seats: readonly PlayerId[],
    message: ServerToClientMessage,
  ): void {
    if (!isOutboundAllowed(this.policy, message.type, { terminal: this.isTerminal(runtime) })) {
      this.counters.droppedByPolicy += 1;
      return;
    }
    for (const seat of seats) {
      const socketId = runtime.seatSockets.get(seat);
      const binding = socketId === undefined ? undefined : runtime.bindings.get(socketId);
      if (
        socketId === undefined ||
        binding === undefined ||
        this.boundSeat(runtime, socketId) !== seat
      ) {
        this.counters.droppedUnbound += 1;
        continue;
      }
      const raw = runtime.table.capabilitiesOf(socketId)?.rawActionData === true;
      const frame = this.rewrite(run, seat, binding, raw, message);
      if (frame !== null) this.sendTo(runtime, socketId, frame);
    }
  }

  /**
   * The frame as this seat's socket may read it. Engine request ids, revisions and event
   * sequences become this seat's own; a board that has not changed is not sent at all; raw action
   * data goes only to a socket that asked for it.
   */
  private rewrite(
    run: AttemptRun,
    seat: PlayerId,
    binding: Binding,
    rawActionData: boolean,
    message: ServerToClientMessage,
  ): ServerToClientMessage | null {
    switch (message.type) {
      case 'playerStateSnapshot': {
        const { revision: _engineRevision, ...projection } = message.payload;
        const board = run.wire.recordBoard(seat, projection);
        if (!board.send) return null;
        return {
          type: 'playerStateSnapshot',
          payload: { ...message.payload, revision: board.revision },
        };
      }
      case 'playerActionRequired': {
        const { request } = message.payload;
        const engineRequestId = request.requestId;
        const previous = run.pending.get(seat);
        const surfaced = run.wire.surfaceDecision(seat, engineRequestId);
        // A re-sent request keeps the revision it was first shown with.
        const wireRevision =
          !surfaced.fresh && previous?.engineRequestId === engineRequestId
            ? previous.wireRevision
            : surfaced.revision;
        run.pending.set(seat, {
          engineRequestId,
          wireRequestId: surfaced.requestId,
          engineRevision: message.payload.revision,
          wireRevision,
        });
        const wired = { ...request, requestId: surfaced.requestId };
        return {
          type: 'playerActionRequired',
          payload: {
            ...message.payload,
            request: rawActionData ? wired : withoutActionData(wired),
            revision: wireRevision,
          },
        };
      }
      case 'eventBatch': {
        // Rebuilt from the fields a table sends: no annotations, no table talk, no snapshot turns.
        const wired = message.payload.lines.map((line) => ({
          engine: line.sequence,
          line: { ...line, sequence: run.wire.nextLogSequence(binding.viewer) },
        }));
        const cues = wireCues(message.payload.cues ?? [], wired);
        return {
          type: 'eventBatch',
          payload: {
            gameId: message.payload.gameId,
            lines: wired.map((entry) => entry.line),
            frontierTurn: message.payload.frontierTurn,
            snapshotTurns: [],
            ...(cues.length > 0 && { cues }),
          },
        };
      }
      case 'error': {
        const { requestId, revision, ...rest } = message.payload;
        if (requestId === undefined && revision === undefined) return message;
        const last = run.lastSubmit.get(seat);
        if (last !== undefined && requestId === last.engineRequestId) {
          return {
            type: 'error',
            payload: { ...rest, requestId: last.wireRequestId, revision: last.wireRevision },
          };
        }
        return { type: 'error', payload: rest };
      }
      case 'gameStarted': {
        const { sessionToken: _sessionToken, ...payload } = message.payload;
        return { type: 'gameStarted', payload };
      }
      default:
        return message;
    }
  }

  private sendTo(
    runtime: TableRuntime,
    socketId: string,
    message: TableServerToClientMessage | ServerToClientMessage,
  ): void {
    try {
      runtime.sockets.get(socketId)?.send(JSON.stringify(message));
    } catch {
      // The close handler owns connection state; a send racing it must not fail a game.
    }
  }

  private runtimeFor(tableId: string): TableRuntime | null {
    const existing = this.runtimes.get(tableId);
    if (existing !== undefined) return existing;
    const table = this.deps.registry.get(tableId);
    if (table === undefined) return null;
    const runtime: TableRuntime = {
      table,
      sockets: new Map(),
      bindings: new Map(),
      seatSockets: new Map(),
      seatGenerations: new Map(),
      nextGeneration: 0,
      run: null,
      ended: null,
    };
    this.runtimes.set(tableId, runtime);
    return runtime;
  }
}
