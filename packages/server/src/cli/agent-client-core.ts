/**
 * The transport-free core of the JSON agent client (`agent-client.ts`).
 *
 * An automated agent plays one seat the same way a browser does: over the existing `/ws`
 * single-player flow (`startGame` → `gameStarted` → `playerActionRequired` →
 * `submitPlayerAction` → `gameOver`). There is no second engine here and no new server message:
 * this module only translates between that protocol and a strict NDJSON agent interface.
 *
 * Two rules shape everything below.
 *
 * 1. **Hidden information.** Only `playerActionRequired` / `playerStateSnapshot` carry a
 *    `PlayerBoardState`, which is the same anti-cheat projection the browser player gets. Every
 *    other frame — `stateSnapshot`, `replayUnlocked`, `eventBatch`, `decisionPending`, AI
 *    annotations — is spectator or full-information data and is dropped rather than translated.
 *    The allow-list is explicit so a new server message cannot leak by default.
 * 2. **The legal menu is the server's.** `legalActions` is published exactly as received,
 *    including any filtering the session applied for yielded abilities, and a reply is checked
 *    against that list. The agent never invents an action, and this client never restores one.
 *
 * It is kept separate from the CLI entry point so the whole state machine is testable without a
 * socket, a process, or stdio.
 */

import { LOSS_REASONS, isPlayerSeatId, parseStrictJson, type StrictJsonFailure } from '@mtg/shared';
import { projectSetupErrorPayload } from '../ws/setup-privacy';
import type {
  ClientToServerMessage,
  ErrorPayload,
  GameOverPayload,
  GameResult,
  HaltKind,
  IgnoredPlayerAbility,
  PlayerBoardState,
  PlayerId,
  ProviderKind,
  SeatSource,
  SeatSummary,
  ServerToClientMessage,
  StartGamePayload,
  TargetChoice,
} from '@mtg/shared';

/** Four seats in v1 (brief §15), matching the server's own `SEAT_COUNT`. */
const SEAT_COUNT = 4;
const SEATS: readonly PlayerId[] = ['P1', 'P2', 'P3', 'P4'];

/** The only hosts the CLI will talk to — the server itself refuses anything else (brief §2). */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** The exact reply fields `SubmitPlayerActionPayload` supports. v1 adds nothing of its own. */
const REPLY_FIELDS: readonly string[] = ['requestId', 'revision', 'actionId', 'targets'];

/**
 * One fixed sentence per `HaltKind`. `MatchSession` already fixes single-player halt reasons, but a
 * halt frame is broadcast, spectator reasons there stay raw, and this client cannot tell from the
 * frame which session wrote it. So the agent's message is *selected* by kind rather than built from
 * the frame: neither `reason`, nor `cardName`, nor the `kind` string itself is ever interpolated.
 */
const AGENT_HALT_MESSAGES: Record<HaltKind, string> = {
  unmodeledCard: 'the game halted: the rules engine met a card it does not model.',
  invalidAiResponse: 'the game halted: an opponent provider returned an unusable response.',
  engineError: 'the game halted: the rules engine could not continue.',
  draw: 'the game halted: the game ended in a draw.',
  aiBudgetExhausted: 'the game halted: the AI budget for this game ran out.',
  turnCap: 'the game halted: the game reached its turn cap.',
};

/** For a halt whose kind is absent or unrecognised. Still terminal, still quoting nothing. */
const AGENT_HALT_UNKNOWN = 'the game halted and no further frames will follow.';

/** `agent-client.ts` casts `JSON.parse` output, so inbound shapes are checked here, not by types. */
function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The `gameId` of an untrusted container, or `null` when it has no usable one. */
function readGameId(container: unknown): string | null {
  const id = readRecord(container)?.['gameId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Rebuild terminal output from validated public fields, never upstream free text. */
function projectAgentGameOver(
  payload: unknown,
): { result: GameResult; standings: GameOverPayload['standings'] } | null {
  const frame = readRecord(payload);
  const result = readRecord(frame?.['result']);
  const gameId = readGameId(result);
  if (result === null || gameId === null) return null;
  const winnerSeat = result['winnerSeat'];
  const finishingOrder = result['finishingOrder'];
  const turnCount = result['turnCount'];
  const halted = result['halted'];
  const haltReason = result['haltReason'];
  if (
    (winnerSeat !== null && !isPlayerSeatId(winnerSeat)) ||
    !Array.isArray(finishingOrder) ||
    typeof turnCount !== 'number' ||
    !Number.isSafeInteger(turnCount) ||
    turnCount < 0 ||
    typeof halted !== 'boolean' ||
    (haltReason !== null && typeof haltReason !== 'string')
  )
    return null;
  const order: PlayerId[] = [];
  for (const seat of finishingOrder) {
    if (!isPlayerSeatId(seat) || order.includes(seat)) return null;
    order.push(seat);
  }
  const incomingStandings = frame?.['standings'];
  if (!Array.isArray(incomingStandings)) return null;
  const standings: GameOverPayload['standings'] = [];
  for (const incoming of incomingStandings) {
    const row = readRecord(incoming);
    if (row === null) return null;
    const seat = row['seat'];
    const position = row['position'];
    const lossReason = row['lossReason'];
    if (
      !isPlayerSeatId(seat) ||
      typeof position !== 'number' ||
      !Number.isInteger(position) ||
      position < 0 ||
      position > SEAT_COUNT ||
      (lossReason !== null &&
        !(typeof lossReason === 'string' && LOSS_REASONS.some((reason) => reason === lossReason)))
    )
      return null;
    standings.push({ seat, position, lossReason });
  }
  return {
    result: { gameId, winnerSeat, finishingOrder: order, turnCount, halted, haltReason: null },
    standings,
  };
}

// ── The agent-facing event stream (stdout, one JSON object per line) ────────────────────────

/** The game is running and this is the seat the agent holds. */
export interface AgentGameStartedEvent {
  type: 'game-started';
  gameId: string;
  seed: string;
  providerKind: ProviderKind;
  humanSeat: PlayerId;
  seats: SeatSummary[];
  startedAt: string;
}

/**
 * The engine is waiting on this seat. `request` and `state` are forwarded verbatim from
 * `playerActionRequired`: `request.legalActions` is the complete menu the agent may choose from,
 * and `requestId`/`revision` are hoisted because a reply must echo both.
 */
export interface AgentDecisionRequiredEvent {
  type: 'decision-required';
  requestId: string;
  revision: number;
  request: PlayerDecisionRequest;
  state: PlayerBoardState;
  ignoredAbilities: IgnoredPlayerAbility[];
}

/** A new board for the agent's seat, with no decision attached. */
export interface AgentStateUpdateEvent {
  type: 'state-update';
  gameId: string;
  revision: number;
  connected: boolean;
  state: PlayerBoardState;
  ignoredAbilities: IgnoredPlayerAbility[];
}

/**
 * Something went wrong. `source` separates a rejected agent reply from a server-side problem, and
 * `fatal` says whether the run is ending — a rejected reply is not fatal, because the same
 * decision is still outstanding and may be answered again.
 *
 * `requestId`/`revision` appear when the server correlated the error to a submission it rejected
 * (`ErrorPayload`); that pair names the decision the agent may answer again. An error without them
 * is unrelated to any outstanding decision, and a submission already in flight stays in flight.
 *
 * `deckIssues` only ever holds this seat's own validation codes, rebuilt by
 * `projectSetupErrorPayload`. There is no `unmodeledCards`: every element of that field is a card
 * name, and three of the four seats belong to opponents.
 */
export interface AgentErrorEvent {
  type: 'error';
  source: 'agent' | 'server';
  fatal: boolean;
  message: string;
  deckIssues?: NonNullable<ErrorPayload['deckIssues']>;
  requestId?: string;
  revision?: number;
}

export interface AgentGameOverEvent {
  type: 'game-over';
  result: GameResult;
  standings: GameOverPayload['standings'];
}

export type AgentEvent =
  | AgentGameStartedEvent
  | AgentDecisionRequiredEvent
  | AgentStateUpdateEvent
  | AgentErrorEvent
  | AgentGameOverEvent;

/**
 * The `DecisionRequest` as it reaches the agent. Structurally the shared type; named here so the
 * event contract reads as player-facing rather than engine-internal.
 */
export type PlayerDecisionRequest = Extract<
  ServerToClientMessage,
  { type: 'playerActionRequired' }
>['payload']['request'];

// ── The agent-facing reply (stdin, one JSON object per outstanding decision) ────────────────

export interface AgentReply {
  requestId: string;
  revision: number;
  actionId: number;
  targets?: TargetChoice[];
}

export type ParsedAgentReply = { ok: true; reply: AgentReply } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function parseTargets(value: unknown): { ok: true; targets: TargetChoice[] } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  const targets: TargetChoice[] = [];
  const seenSlots = new Set<number>();
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false };
    if (Object.keys(entry).some((key) => key !== 'slot' && key !== 'choice')) {
      return { ok: false };
    }
    const slot = entry['slot'];
    const choice = entry['choice'];
    if (!isIndex(slot) || typeof choice !== 'string' || choice.length === 0) return { ok: false };
    if (seenSlots.has(slot)) return { ok: false };
    seenSlots.add(slot);
    targets.push({ slot, choice });
  }
  return { ok: true, targets };
}

/**
 * Why a reply line was refused before any field of it was read. The text is fixed per verdict and
 * quotes nothing back: a line whose keys are ambiguous has no field worth echoing.
 */
const STRICT_JSON_REJECTIONS: Record<StrictJsonFailure, string> = {
  duplicateKey:
    'reply is not valid JSON for this interface: an object in it repeats a key, so which value ' +
    'was meant is ambiguous. Send each field once.',
  tooDeep: 'reply is not valid JSON for this interface: it nests deeper than the parser accepts.',
  malformed: 'reply is not valid JSON.',
};

/**
 * Validate one input line into the exact shape `SubmitPlayerActionPayload` accepts.
 *
 * The line is read with `parseStrictJson`, not `JSON.parse`: a repeated key resolves last-wins in
 * the native parser, so `{"actionId":9,"actionId":0}` would submit action 0 while the line as
 * written also says 9. A refusal here is not fatal — the decision stays outstanding and the agent
 * may answer it again unambiguously.
 *
 * Unknown fields are rejected rather than dropped. A decision carrying `manaSplit` or
 * `combatDamageSplit` cannot be answered with a split in v1 — the server's own
 * `submitPlayerAction` has nowhere to put one — and an agent that guessed at the field name
 * deserves to be told so instead of watching its distribution vanish silently.
 */
export function parseAgentReply(line: string): ParsedAgentReply {
  const strict = parseStrictJson(line);
  if (!strict.ok) return { ok: false, message: STRICT_JSON_REJECTIONS[strict.reason] };
  const parsed = strict.value;
  if (!isRecord(parsed)) return { ok: false, message: 'reply must be a JSON object.' };

  const unsupported = Object.keys(parsed).filter((key) => !REPLY_FIELDS.includes(key));
  if (unsupported.length > 0) {
    return {
      ok: false,
      message:
        `reply carries unsupported field(s): ${unsupported.join(', ')}. ` +
        `v1 accepts only ${REPLY_FIELDS.join(', ')}.`,
    };
  }

  const requestId = parsed['requestId'];
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { ok: false, message: 'reply needs a non-empty string requestId.' };
  }
  const revision = parsed['revision'];
  if (!isIndex(revision)) {
    return { ok: false, message: 'reply needs a non-negative integer revision.' };
  }
  const actionId = parsed['actionId'];
  if (!isIndex(actionId)) {
    return { ok: false, message: 'reply needs a non-negative integer actionId.' };
  }
  if (parsed['targets'] === undefined) {
    return { ok: true, reply: { requestId, revision, actionId } };
  }
  const targets = parseTargets(parsed['targets']);
  if (!targets.ok) {
    return {
      ok: false,
      message: 'reply targets must be unique slots with { slot: integer >= 0, choice: string }.',
    };
  }
  return { ok: true, reply: { requestId, revision, actionId, targets: targets.targets } };
}

// ── Session ────────────────────────────────────────────────────────────────────────────────

export interface AgentClientIo {
  /** One NDJSON event on stdout. */
  event(event: AgentEvent): void;
  /** Human-facing diagnostics, never stdout — the event stream must stay machine-parseable. */
  diagnostic(message: string): void;
}

export interface AgentClientTransport {
  send(message: ClientToServerMessage): void;
  close(): void;
}

/** The two byte sinks the CLI owns: stdout carries events, stderr carries everything else. */
export interface AgentStreams {
  writeOut(chunk: string): void;
  writeErr(chunk: string): void;
}

/**
 * NDJSON on stdout, prose on stderr. `JSON.stringify` never emits a raw newline (one inside a
 * string is escaped), so an event is always exactly one line and a reader may split on newlines.
 */
export function createAgentIo(streams: AgentStreams): AgentClientIo {
  return {
    event: (event) => streams.writeOut(`${JSON.stringify(event)}\n`),
    diagnostic: (message) => streams.writeErr(`agent-client: ${message}\n`),
  };
}

/**
 * Reassembles newline-delimited input from arbitrarily chunked stream reads. A pipe splits
 * wherever it likes, so a reply can arrive in pieces; treating each chunk as a line would reject
 * perfectly good JSON.
 */
export class LineBuffer {
  private partial = '';

  /** Complete lines from this chunk. A trailing fragment is held for the next one. */
  take(chunk: string): string[] {
    this.partial += chunk;
    const lines = this.partial.split('\n');
    this.partial = lines.pop() ?? '';
    return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }

  /** Whatever is left when the stream ends without a final newline. */
  flush(): string[] {
    const rest = this.partial;
    this.partial = '';
    return rest.length > 0 ? [rest] : [];
  }
}

/** The single-player game this client asks the server to start. */
export interface AgentGameOptions {
  seats: SeatSource[];
  providerKind: ProviderKind;
  humanSeat: PlayerId;
  seed?: string;
  paceMs?: number;
}

export interface AgentClientSessionOptions {
  io: AgentClientIo;
  transport: AgentClientTransport;
  game: AgentGameOptions;
  /** Called once with the process exit code when the run is over. */
  onDone?: (code: number) => void;
}

/** Build the `startGame` payload. Always single-player: this client is one seat, never a viewer. */
export function startGamePayload(game: AgentGameOptions): StartGamePayload {
  return {
    seats: game.seats,
    providerKind: game.providerKind,
    gameMode: 'singlePlayer',
    humanSeat: game.humanSeat,
    ...(game.seed !== undefined && { seed: game.seed }),
    ...(game.paceMs !== undefined && { paceMs: game.paceMs }),
  };
}

interface OutstandingDecision {
  requestId: string;
  revision: number;
  /** Ids from the menu as received, so a reply is checked against what was actually offered. */
  actionIds: Set<number>;
}

/**
 * Drives one single-player game for one agent. Server frames go in through `receive`, agent reply
 * lines through `reply`, and everything the agent may see comes back out through `io`.
 */
export class AgentClientSession {
  private started = false;
  /** The id of the one game this client adopted. Terminal frames are scoped to it. */
  private activeGameId: string | null = null;
  private finished = false;
  private outstanding: OutstandingDecision | null = null;
  /** A reply is in flight: the server has it and has neither accepted nor rejected it yet. */
  private submitted = false;
  private agentInputClosed = false;
  private socketOpen = true;
  /** Frame types already reported as dropped, so the notice is a fact and not a running tally. */
  private readonly reportedDrops = new Set<string>();

  constructor(private readonly opts: AgentClientSessionOptions) {}

  /** Ask for the game. Called once the socket is open. */
  begin(): void {
    this.opts.transport.send({ type: 'startGame', payload: startGamePayload(this.opts.game) });
  }

  receive(message: ServerToClientMessage): void {
    if (this.finished) return;
    switch (message.type) {
      case 'gameStarted': {
        const payload = message.payload;
        // A spectator game belongs to some other client: the server broadcasts those to every
        // socket, and adopting one would have this agent answer for a seat it does not hold.
        if (payload.gameMode !== 'singlePlayer') {
          this.opts.io.diagnostic('ignored a gameStarted frame for a spectator game.');
          return;
        }
        // Exactly one game is ever adopted. A later start frame is some other client's game, and
        // letting it overwrite `activeGameId` would move the terminal scope off this game — the run
        // would then end on a stranger's halt and ignore its own.
        if (this.started) {
          this.opts.io.diagnostic('ignored a gameStarted frame; this client already holds a game.');
          return;
        }
        const gameId = readGameId(payload);
        if (gameId === null) {
          this.opts.io.diagnostic('ignored a gameStarted frame carrying no usable game id.');
          return;
        }
        // The seat is the one this client asked for, or the frame is not about this client. The
        // server sets `humanSeat` on every single-player start, so an absent one is not ours.
        if (payload.humanSeat !== this.opts.game.humanSeat) {
          this.opts.io.diagnostic('ignored a gameStarted frame for a seat it did not request.');
          return;
        }
        this.started = true;
        this.activeGameId = gameId;
        this.opts.io.event({
          type: 'game-started',
          gameId,
          seed: payload.seed,
          providerKind: payload.providerKind,
          humanSeat: this.opts.game.humanSeat,
          seats: payload.seats,
          startedAt: payload.startedAt,
          // `sessionToken` is deliberately not republished: v1 does not reconnect, so exposing
          // the takeover credential on stdout would only widen the surface.
        });
        return;
      }

      case 'playerActionRequired': {
        const { request, state, revision, ignoredAbilities } = message.payload;
        if (request.manaSplit !== undefined || request.combatDamageSplit !== undefined) {
          this.fail(
            'agent',
            `decision ${request.requestId} needs a split the v1 submission wire cannot express.`,
          );
          return;
        }
        const sameDecision =
          this.outstanding?.requestId === request.requestId &&
          this.outstanding.revision === revision;
        this.outstanding = {
          requestId: request.requestId,
          revision,
          actionIds: new Set(request.legalActions.map((action) => action.id)),
        };
        if (!sameDecision) this.submitted = false;
        this.opts.io.event({
          type: 'decision-required',
          requestId: request.requestId,
          revision,
          request,
          state,
          ignoredAbilities,
        });
        if (this.agentInputClosed && !this.submitted) {
          this.fail(
            'agent',
            `agent input is closed; decision ${request.requestId} cannot be answered.`,
          );
        }
        return;
      }

      case 'playerStateSnapshot': {
        const { gameId, state, revision, connected, ignoredAbilities } = message.payload;
        this.opts.io.event({
          type: 'state-update',
          gameId,
          revision,
          connected,
          state,
          ignoredAbilities,
        });
        return;
      }

      case 'gameOver': {
        // `gameOver` carries its identity one level down, inside `result`.
        if (!this.ownsTerminal(readGameId(readRecord(message.payload)?.['result']))) {
          this.opts.io.diagnostic('ignored a gameOver frame that is not for this game.');
          return;
        }
        const projected = projectAgentGameOver(message.payload);
        if (projected === null) {
          this.opts.io.diagnostic('ignored a malformed gameOver frame.');
          return;
        }
        this.opts.io.event({
          type: 'game-over',
          result: projected.result,
          standings: projected.standings,
        });
        this.finish(0);
        return;
      }

      case 'computeHalted': {
        // A halt is terminal: the runner stops without a `gameOver`, so waiting for one hangs.
        // Its identity sits at the top level of the payload, unlike `gameOver`'s.
        const payload = readRecord(message.payload);
        if (!this.ownsTerminal(readGameId(payload))) {
          this.opts.io.diagnostic('ignored a computeHalted frame that is not for this game.');
          return;
        }
        const kind = payload?.['kind'];
        const known =
          typeof kind === 'string' && Object.hasOwn(AGENT_HALT_MESSAGES, kind)
            ? (kind as HaltKind)
            : null;
        this.fail('server', known === null ? AGENT_HALT_UNKNOWN : AGENT_HALT_MESSAGES[known]);
        return;
      }

      case 'error': {
        const { message: text, requestId, revision } = message.payload;
        // Before `gameStarted` the only errors are setup refusals, and nothing will follow them.
        // A refusal reports all four seats at once, so it is the one inbound frame that carries
        // other players' deck data; it is rebuilt from an allowlist keyed on the seat this client
        // asked to play, not forwarded. Its own `message` goes no further than this process.
        if (!this.started) {
          this.opts.io.event({
            type: 'error',
            source: 'server',
            fatal: true,
            ...projectSetupErrorPayload(message.payload, this.opts.game.humanSeat),
          });
          this.finish(1);
          return;
        }
        // Only a rejection the server correlated to *this* in-flight submission leaves the same
        // decision outstanding and answerable again (`ErrorPayload.requestId`/`revision`). An
        // uncorrelated error says nothing about the action: clearing the guard on one would let a
        // second reply reach a submission the server had in fact accepted.
        const outstanding = this.outstanding;
        const rejectsSubmission =
          this.submitted &&
          outstanding !== null &&
          requestId === outstanding.requestId &&
          revision === outstanding.revision;
        if (rejectsSubmission) this.submitted = false;
        // Deck diagnostics belong to setup and nothing after `gameStarted` legitimately sets
        // them, so they are dropped here rather than republished on a path with no projection.
        this.opts.io.event({
          type: 'error',
          source: 'server',
          fatal: false,
          message: text,
          ...(requestId !== undefined && { requestId }),
          ...(revision !== undefined && { revision }),
        });
        // The retry the rejection invites needs an input stream to arrive on. Without one the
        // decision can never be answered and the engine would wait on this seat forever.
        if (rejectsSubmission && this.agentInputClosed) {
          this.fail(
            'agent',
            `submission for decision ${outstanding.requestId} was rejected and agent input is ` +
              'closed; it cannot be answered again.',
          );
        }
        return;
      }

      case 'sessionPaused':
        this.opts.io.diagnostic(`session paused: ${message.payload.reason}.`);
        return;

      // Spectator, replay, and debug frames. Not part of the agent surface, and `replayUnlocked`
      // and `stateSnapshot` in particular carry the full-information board this seat must not see.
      case 'stateSnapshot':
      case 'replayUnlocked':
      case 'eventBatch':
      case 'decisionPending':
      case 'apiWaiting':
      case 'debugEvents':
      case 'gameReflections':
        // Once per type: a long game produces hundreds of `eventBatch` frames, and repeating the
        // same line for each buries the diagnostics that matter.
        if (!this.reportedDrops.has(message.type)) {
          this.reportedDrops.add(message.type);
          this.opts.io.diagnostic(
            `dropping every ${message.type} frame; not part of the agent surface.`,
          );
        }
        return;
    }
  }

  /** Handle one line of agent input. */
  reply(line: string): void {
    if (this.finished) return;
    if (line.trim().length === 0) return;

    const parsed = parseAgentReply(line);
    if (!parsed.ok) {
      this.reject(parsed.message);
      return;
    }
    const reply = parsed.reply;
    const outstanding = this.outstanding;
    if (outstanding === null) {
      this.reject(`no decision is outstanding; ${reply.requestId} cannot be answered.`);
      return;
    }
    if (reply.requestId !== outstanding.requestId) {
      this.reject(
        `reply requestId ${reply.requestId} is stale; the outstanding decision is ${outstanding.requestId}.`,
      );
      return;
    }
    if (reply.revision !== outstanding.revision) {
      this.reject(
        `reply revision ${reply.revision} is stale; decision ${outstanding.requestId} is at revision ${outstanding.revision}.`,
      );
      return;
    }
    if (this.submitted) {
      this.reject(
        `a reply for ${outstanding.requestId} was already submitted; wait for the next event.`,
      );
      return;
    }
    if (!outstanding.actionIds.has(reply.actionId)) {
      this.reject(
        `actionId ${reply.actionId} is not on the legal menu for ${outstanding.requestId}.`,
      );
      return;
    }

    this.submitted = true;
    this.opts.transport.send({
      type: 'submitPlayerAction',
      payload: {
        requestId: reply.requestId,
        revision: reply.revision,
        actionId: reply.actionId,
        ...(reply.targets !== undefined && { targets: reply.targets }),
      },
    });
  }

  /** The agent closed its input stream. */
  inputClosed(): void {
    if (this.finished) return;
    this.agentInputClosed = true;
    this.opts.io.diagnostic('agent input stream closed.');
    // An unanswered decision can now never be answered, and the engine waits forever.
    if (this.outstanding !== null && !this.submitted) {
      this.fail(
        'agent',
        `agent input is closed; decision ${this.outstanding.requestId} cannot be answered.`,
      );
    }
  }

  /** The socket closed. Before `gameOver` that is a lost game, not a clean finish. */
  socketClosed(): void {
    this.socketOpen = false;
    if (this.finished) return;
    this.fail('agent', 'the server connection closed before the game ended.');
  }

  /**
   * Whether a terminal frame is this client's. Nothing inside the frame is read before this answers
   * true: a halt or game over for another session must leave the lifecycle exactly as it was and put
   * no upstream text on stdout, however the frame is shaped.
   */
  private ownsTerminal(gameId: string | null): boolean {
    return this.started && this.activeGameId !== null && gameId === this.activeGameId;
  }

  private reject(message: string): void {
    this.opts.io.event({ type: 'error', source: 'agent', fatal: false, message });
  }

  private fail(source: AgentErrorEvent['source'], message: string): void {
    this.opts.io.event({ type: 'error', source, fatal: true, message });
    this.finish(1);
  }

  private finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    // A single-player session outlives its socket — the server keeps it for a reconnect and
    // refuses the next `startGame` until it is released. Abandoning is a no-op on a finished or
    // halted runner (`MatchRunner.abandon`), so the recorded game keeps its real status; skipping
    // it instead leaves this CLI good for exactly one game per server process. Only ever for a
    // game this client started: on someone else's session the server rejects it, and before
    // `gameStarted` there is nothing of ours to release.
    if (this.started && this.socketOpen) {
      this.opts.transport.send({ type: 'abandonGame', payload: {} });
    }
    this.opts.transport.close();
    this.opts.onDone?.(code);
  }
}

// ── Argument parsing ───────────────────────────────────────────────────────────────────────

export type AgentClientArgs =
  | { kind: 'run'; url: string; game: AgentGameOptions }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export const AGENT_CLIENT_USAGE = `Play one Commander seat over the local server as a JSON agent.

  bun run agent-client [options] < replies.ndjson

Options
  --url <ws url>      WebSocket endpoint (default ws://127.0.0.1:3001/ws; loopback only)
  --port <n>          Shorthand for ws://127.0.0.1:<n>/ws
  --seat <P1..P4>     Seat the agent plays (default P1)
  --seed <string>     Game seed (default: the server generates one)
  --provider <kind>   Opponent decisions: random | ai (default random)
  --pace-ms <n>       Bot presentation pace in ms (default 0 — no artificial delay)
  --help              Show this message

Interface
  stdout  NDJSON events: game-started, decision-required, state-update, error, game-over
  stderr  diagnostics only
  stdin   one reply per decision: {"requestId":"…","revision":N,"actionId":N,"targets":[…]}`;

/**
 * Parse CLI flags. Returns a discriminated result rather than throwing so the entry point can
 * report the problem on stderr and exit without a stack trace.
 */
export function parseAgentClientArgs(argv: readonly string[]): AgentClientArgs {
  let url: string | undefined;
  let port: number | undefined;
  let humanSeat: PlayerId = 'P1';
  let seed: string | undefined;
  let providerKind: ProviderKind = 'random';
  let paceMs = 0;

  /** The value after a flag, or null when the flag was passed bare or followed by another flag. */
  const value = (index: number): string | null => {
    const next = argv[index];
    if (next === undefined || next.startsWith('--')) return null;
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case '--help':
      case '-h':
        return { kind: 'help' };
      case '--url': {
        const next = value(++i);
        if (next === null) return { kind: 'error', message: '--url needs a WebSocket url.' };
        url = next;
        break;
      }
      case '--port': {
        const next = value(++i);
        const parsed = next === null ? Number.NaN : Number.parseInt(next, 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
          return { kind: 'error', message: '--port needs a port number between 1 and 65535.' };
        }
        port = parsed;
        break;
      }
      case '--seat': {
        const next = value(++i);
        if (next === null || !SEATS.includes(next)) {
          return { kind: 'error', message: `--seat needs one of ${SEATS.join(', ')}.` };
        }
        humanSeat = next;
        break;
      }
      case '--seed': {
        const next = value(++i);
        if (next === null) return { kind: 'error', message: '--seed needs a value.' };
        seed = next;
        break;
      }
      case '--provider': {
        const next = value(++i);
        if (next !== 'random' && next !== 'ai') {
          return { kind: 'error', message: '--provider needs random or ai.' };
        }
        providerKind = next;
        break;
      }
      case '--pace-ms': {
        const next = value(++i);
        const parsed = next === null ? Number.NaN : Number.parseInt(next, 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return { kind: 'error', message: '--pace-ms needs a non-negative integer.' };
        }
        paceMs = parsed;
        break;
      }
      default:
        return { kind: 'error', message: `Unknown option ${flag}. Try --help.` };
    }
  }

  if (url !== undefined && port !== undefined) {
    return { kind: 'error', message: 'Pass either --url or --port, not both.' };
  }
  const endpoint = url ?? `ws://127.0.0.1:${port ?? 3001}/ws`;
  const problem = loopbackProblem(endpoint);
  if (problem !== null) return { kind: 'error', message: problem };

  return {
    kind: 'run',
    url: endpoint,
    game: {
      seats: Array.from({ length: SEAT_COUNT }, (): SeatSource => ({ kind: 'pool' })),
      providerKind,
      humanSeat,
      ...(seed !== undefined && { seed }),
      paceMs,
    },
  };
}

/**
 * The server binds loopback only and rejects a foreign host anyway (brief §2). Checking here too
 * keeps the failure legible — and keeps this CLI from becoming the thing that reaches a remote
 * game server without the authenticated design that would require.
 */
function loopbackProblem(endpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return `${endpoint} is not a valid url.`;
  }
  if (parsed.protocol !== 'ws:') return `${endpoint} must use the ws: scheme.`;
  if (!LOOPBACK_HOSTS.includes(parsed.hostname)) {
    return `${endpoint} is not a loopback host; this client only plays a local server.`;
  }
  return null;
}
