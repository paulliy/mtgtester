/**
 * The tester's game host: single-player and watch games, driven by protocol frames and answered
 * through each connection's `send`. It knows nothing of sockets or HTTP, so the Bun server
 * (`ws/server.ts`, which extends it) and a browser worker run the same logic (ADR 0053).
 *
 * The Card Test Lab and batches stay in the Bun server: the host only calls the hooks it
 * overrides (`labScenario`, `batchActive`), and the model-backed seat services arrive as
 * `deps.ai`, absent in the browser.
 */

import {
  assertNever,
  isClientToServerMessage,
  isPlayerSeatId,
  parseStrictJson,
  PLAYER_IDLE_GRACE_MS,
  type StrictJsonFailure,
} from '@mtg/shared';
import type {
  ClientCapabilities,
  ClientToServerMessage,
  GameReportBuild,
  GameMode,
  GameReportCardData,
  GameStartedPayload,
  PlayerId,
  ServerToClientMessage,
  StartGamePayload,
} from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';
import type { SupportedPool } from '../cards/pool';
import type { CardTestScenario } from '../cards/card-test-scenarios';
import type { GameStore } from '../db';
import type { DeckStore } from '../db/deck-store';
import type { BannedList } from '../decks/banned';
import type { ReportSeatSource } from '../match/report';
import type { ReplayIdentity } from '../match/replay-config';
import { MatchSession } from '../match/session';
import type { SessionAi } from '../match/session-ai';
import { withoutActionData } from '../match/presentation';
import { disclosedSeatSummaries, seedLabel, testerPolicy } from '../match/disclosure';
import { setupSeats, type SeatSetupDeps } from '../match/setup';
import { previewMatchup, type PreviewRequest } from '../match/preview';
import { projectSetupProblems, SETUP_REFUSED_MESSAGE } from '../ws/setup-privacy';

function replayOption(identity: ReplayIdentity | undefined): { replay?: ReplayIdentity } {
  return identity === undefined ? {} : { replay: identity };
}

/**
 * Where a game's frames go. The host runs spectator and single-player games only; a table
 * runs in `serve:table`, so asking this about one is a bug and throws.
 *
 * flow: player socket, session token and start-frame routing (m1 rows 918, 928, 929, 950).
 */
function routeOf(mode: GameMode): 'player' | 'broadcast' {
  switch (mode) {
    case 'singlePlayer':
      return 'player';
    case 'spectator':
      return 'broadcast';
    case 'table':
      throw new Error('The game host does not run table games');
    default:
      return assertNever(mode, 'game server route');
  }
}

/**
 * Whether a requester holds one seat, so its refusals are projected to that seat instead of
 * naming every failing deck (m1 rows 562, 863, 886, following 824).
 *
 * fence: `'table'` takes the restrictive answer, as single-player.
 */
function holdsOneSeat(mode: GameMode): boolean {
  switch (mode) {
    case 'singlePlayer':
    case 'table':
      return true;
    case 'spectator':
      return false;
    default:
      return assertNever(mode, 'setup refusal projection');
  }
}

/**
 * Whether a player can resume a session of this mode (m1 row 680).
 *
 * flow: unreachable for `'table'`, which the host refuses to start; refused if it ever is.
 */
function resumable(mode: GameMode): boolean {
  switch (mode) {
    case 'singlePlayer':
      return true;
    case 'spectator':
    case 'table':
      return false;
    default:
      return assertNever(mode, 'game resume');
  }
}

/**
 * Whether a session of this mode has a "Copy game report" (m1 row 441).
 *
 * fence: only a single-player session does; a table is a 404, like a spectator game.
 */
function hasGameReport(mode: GameMode): boolean {
  switch (mode) {
    case 'singlePlayer':
      return true;
    case 'spectator':
    case 'table':
      return false;
    default:
      return assertNever(mode, 'game report availability');
  }
}

/**
 * The preview-cache key for a start request, so a preview and the start that redeems it compare
 * the same fields in the same order. The human seat joins it only when the mode has one.
 *
 * flow: the human seat in a preview or start request (m1 rows 402, 841).
 */
function previewRequestFor(
  payload: StartGamePayload,
  seats: StartGamePayload['seats'],
  seed: string,
): PreviewRequest {
  const base = {
    seats,
    seed,
    providerKind: payload.providerKind,
    gameMode: payload.gameMode ?? 'spectator',
  } as const;
  switch (payload.gameMode) {
    case undefined:
    case 'spectator':
      return base;
    case 'singlePlayer':
      return { ...base, humanSeat: payload.humanSeat };
    default:
      return assertNever(payload, 'preview request mode');
  }
}

export interface GameHostDeps {
  pool: SupportedPool;
  index: OracleIndex;
  banned: BannedList;
  store?: GameStore | undefined;
  /**
   * Where deck setup keeps imported decks when there is no `store`: memory, in the browser.
   * Ignored when a `store` is given. Games are recorded only in a `store`.
   */
  decks?: DeckStore | undefined;
  /** The model-backed seat services. Without them a game with model seats is refused. */
  ai?: SessionAi | undefined;
  /** Explicit opt-in for closed, unpersisted deterministic viewer scenarios. */
  cardTestLab?: boolean;
  /** The checkout this host runs from, for "Copy game report". Unknown when omitted. */
  build?: GameReportBuild;
  /** The Oracle data file this host loaded, for "Copy game report". Unknown when omitted. */
  cardData?: GameReportCardData;
}

/** One client of the host: a WebSocket on the server, a message port in the browser. */
export interface HostConnection {
  send(frame: string): unknown;
}

/** An HTTP-shaped answer the host gives without knowing about HTTP. */
export interface HostReply {
  status: number;
  body: unknown;
}

/** Four seats in v1; the count is a parameter, but only four is supported and tested (§15). */
const SEAT_COUNT = 4;

/**
 * How long a match survives with nobody watching. A page reload drops the socket for a moment and
 * must not kill the game; a spectator who closed the tab must not leave one running, holding an
 * engine and a `games` row that reads `running` forever.
 */
export const ORPHAN_GRACE_MS = 30_000;

/**
 * The fixed reply to a frame that could not be read unambiguously. One sentence per verdict, with
 * nothing quoted back from the text: a frame whose keys repeat cannot be said to *have* a
 * `requestId`, so echoing one would invent a correlation the client could act on.
 *
 * No byte cap is applied to inbound frames here — a `startGame` frame carries four plaintext
 * decklists — but nesting is bounded by `STRICT_JSON_MAX_DEPTH`.
 */
const INBOUND_FRAME_REJECTIONS: Record<StrictJsonFailure, string> = {
  duplicateKey: 'Ambiguous JSON frame: an object in it repeats a key. Send each field once.',
  tooDeep: 'JSON frame nests too deeply.',
  malformed: 'Malformed JSON frame.',
};

/**
 * The fixed reply to a `/api/setup-preview` body that could not be read unambiguously. One message
 * for every verdict, quoting nothing: the disputed values of a repeated key must not come back out.
 */
export const SETUP_PREVIEW_BODY_REJECTION =
  'Unreadable JSON body. Send well-formed JSON, each field once.';

export class GameHost<C extends HostConnection = HostConnection> {
  protected readonly sockets = new Set<C>();
  /**
   * What each connection declared in its latest `startGame`, `startCardTestScenario` or
   * `resumeGame` (ADR 0032 decision 7). A connection that declared nothing is not in the map. A
   * resumed connection is a new socket with its own declaration, so nothing carries over from the
   * one it replaces.
   */
  private readonly capabilities = new WeakMap<C, ClientCapabilities>();
  protected session: MatchSession | null = null;
  protected startingGame = false;
  private startingSocket: C | null = null;
  private startGeneration = 0;
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private playerIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private playerSocket: C | null = null;
  /** The seat `playerSocket` plays: the one human seat of the single-player game it holds. */
  private playerSeat: PlayerId | null = null;
  protected sessionToken: string | null = null;
  protected startedPayload: GameStartedPayload | null = null;
  /** How each seat's deck was chosen, and the lab scenario if any — for "Copy game report". */
  private reportSources: { sources: ReportSeatSource[]; cardTestScenarioId: string | null } | null =
    null;
  private readonly setupPreviews = new Map<
    string,
    { request: PreviewRequest; createdAt: number }
  >();

  constructor(protected readonly deps: GameHostDeps) {}

  /** A client connected: a socket opened, or a browser page attached to its worker. */
  open(connection: C): void {
    this.onSocketOpen(connection);
  }

  /** A client went away. A single-player game waits for it to resume. */
  close(connection: C): void {
    this.onSocketClose(connection);
  }

  /** One inbound protocol frame from `connection`, as text. */
  receive(connection: C, frame: string): Promise<void> {
    return this.handleMessage(connection, frame);
  }

  /** The setup preview for a request body (`POST /api/setup-preview`). */
  previewSetup(body: string): Promise<HostReply> {
    return this.setupPreview(body);
  }

  /** The "Copy game report" payload for a request body (`POST /api/game-report`). */
  gameReport(body: string): HostReply {
    return this.gameReportFor(body);
  }

  /** What deck setup reads: the database when there is one, else the memory deck store. */
  private setupDeps(): SeatSetupDeps {
    const decks = this.deps.decks;
    return this.deps.store !== undefined || decks === undefined
      ? this.deps
      : { ...this.deps, store: decks };
  }

  /** Whether a batch is running, which blocks starting a game. Only the Bun server runs them. */
  protected batchActive(): boolean {
    return false;
  }

  /** A Card Test Lab scenario by id. Only the Bun server carries the catalog. */
  protected labScenario(
    _scenarioId: string,
    _gameId: GameStartedPayload['gameId'],
  ): CardTestScenario | null {
    return null;
  }

  /** Broadcast to every connected spectator. One game at a time (brief §15). */
  private broadcast(message: ServerToClientMessage): void {
    for (const socket of this.sockets) {
      try {
        socket.send(this.frameFor(socket, message));
      } catch {
        // A socket that died between the readyState check and the send is not an error worth
        // failing a game over; the close handler removes it.
      }
    }
  }

  private wantsRawActionData(socket: C): boolean {
    return this.capabilities.get(socket)?.rawActionData === true;
  }

  /** The frame as this connection may receive it: `decisionPending` loses raw `data` unless asked. */
  private frameFor(socket: C, message: ServerToClientMessage): string {
    if (message.type === 'decisionPending' && !this.wantsRawActionData(socket)) {
      return JSON.stringify({
        ...message,
        payload: { ...message.payload, request: withoutActionData(message.payload.request) },
      });
    }
    return JSON.stringify(message);
  }

  private sendTo(socket: C, message: ServerToClientMessage): void {
    try {
      socket.send(this.frameFor(socket, message));
    } catch {
      // The close callback owns connection state. A send racing with it must not fail a match.
    }
  }

  /**
   * Whether `gameId` is a game in progress whose reasoning and debug data would hand its players
   * what the live stream withholds (ADR 0022 §3).
   *
   * fence: annotations and debug routes (m1 rows 298, 336). They are open from the start only
   * when the policy releases both live; otherwise they wait for the game to end, as single-player.
   */
  protected holdsUnfinishedGame(gameId: string): boolean {
    const session = this.session;
    if (this.startedPayload?.gameId !== gameId || session === null) return false;
    const mode = session.getGameMode();
    switch (mode) {
      case 'spectator':
      case 'singlePlayer':
      case 'table': {
        const policy = session.getDisclosurePolicy();
        if (policy.annotations === 'live' && policy.debugEvents) return false;
        return session.runner.getStatus() !== 'finished';
      }
      default:
        return assertNever(mode, 'unfinished game lock');
    }
  }

  /**
   * `POST /api/setup-preview`, given the body's text. The only setup entry point that does not
   * arrive as a frame, so it needs the same strict read: `request.json()` resolves a repeated key
   * by last-wins, and a body carrying two different `humanSeat` values would otherwise be
   * previewed — and cached as a startable token — under whichever half the native parser kept.
   * The raw text is therefore handed to `parseStrictJson` before any shape validation.
   *
   * A body that could not be read unambiguously gets one fixed message for every verdict: nothing
   * from an ambiguous text may be quoted back, and the caller is a local UI that only needs to
   * know the body was refused. The schema and seat-count refusals, the 200 shape, the preview
   * cache and the seed default below are unchanged.
   */
  protected async setupPreview(text: string): Promise<HostReply> {
    const strict = parseStrictJson(text);
    if (!strict.ok) return { status: 400, body: { message: SETUP_PREVIEW_BODY_REJECTION } };
    const body: unknown = strict.value;
    if (!isClientToServerMessage({ type: 'startGame', payload: body }))
      return { status: 400, body: { message: 'Invalid setup selections.' } };
    const selected = body as StartGamePayload;
    // flow: tables run only in `serve:table` (m1 row 402). The parser never admits `'table'`;
    // this holds the line if a caller reaches here some other way.
    const requestedMode = (selected.gameMode ?? 'spectator') as GameMode;
    switch (requestedMode) {
      case 'table':
        return { status: 400, body: { message: SETUP_REFUSED_MESSAGE } };
      case 'spectator':
      case 'singlePlayer':
        break;
      default:
        assertNever(requestedMode, 'setup preview mode');
    }
    if (selected.seats.length !== SEAT_COUNT)
      return { status: 400, body: { message: 'Exactly four seats are required.' } };
    const previewRequest = previewRequestFor(
      selected,
      selected.seats,
      selected.seed?.trim() || crypto.randomUUID().slice(0, 8),
    );
    const preview = await previewMatchup(previewRequest, this.setupDeps());
    const previewId = crypto.randomUUID();
    for (const [id, entry] of this.setupPreviews)
      if (Date.now() - entry.createdAt > 600_000) this.setupPreviews.delete(id);
    if (this.setupPreviews.size >= 32)
      this.setupPreviews.delete(this.setupPreviews.keys().next().value as string);
    this.setupPreviews.set(previewId, { request: previewRequest, createdAt: Date.now() });
    return { status: 200, body: { ...preview, previewId } };
  }

  /**
   * `POST /api/game-report` with `{ sessionToken }`, given the body's text: the "Copy game report" payload for the
   * single-player game that token resumes. The token is the same reconnect credential `resumeGame`
   * checks, so only the player's own browser can export a live game — and the session builds the
   * report from the human seat, keeping opponents' decks hidden until the game is over. POST
   * keeps the token out of URLs and request logs.
   */
  protected gameReportFor(text: string): HostReply {
    const strict = parseStrictJson(text);
    const token =
      strict.ok &&
      typeof strict.value === 'object' &&
      strict.value !== null &&
      !Array.isArray(strict.value)
        ? (strict.value as Record<string, unknown>)['sessionToken']
        : undefined;
    if (typeof token !== 'string' || token.length === 0)
      return { status: 400, body: { message: 'A session token is required.' } };
    const session = this.session;
    if (
      session === null ||
      !hasGameReport(session.getGameMode()) ||
      this.sessionToken === null ||
      token !== this.sessionToken
    )
      return { status: 404, body: { message: 'That single-player session is unavailable.' } };
    return {
      status: 200,
      body: session.gameReport({
        build: this.deps.build ?? { commit: null, branch: null, dirty: null },
        cardData: this.deps.cardData ?? { source: null, sha256: null, entries: 0 },
        startedAt: this.startedPayload?.startedAt ?? null,
        sources: this.reportSources?.sources ?? [],
        cardTestScenarioId: this.reportSources?.cardTestScenarioId ?? null,
      }),
    };
  }

  protected async handleMessage(socket: C, raw: string | Uint8Array): Promise<void> {
    // Every inbound frame is read strictly, before its `type` is known: choosing a parsing
    // policy from the discriminant of an already ambiguous text would be circular. A frame that
    // repeats a key has no single meaning, so nothing in it — not even `requestId` — may be
    // treated as correlation (`INBOUND_FRAME_REJECTIONS`).
    const strict = parseStrictJson(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    if (!strict.ok) {
      this.sendTo(socket, {
        type: 'error',
        payload: { message: INBOUND_FRAME_REJECTIONS[strict.reason] },
      });
      return;
    }
    const parsed: unknown = strict.value;

    // A socket frame is never trusted; the union is erased at runtime (brief §11).
    if (!isClientToServerMessage(parsed)) {
      const candidate =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const payload =
        candidate?.['type'] === 'submitPlayerAction' &&
        typeof candidate['payload'] === 'object' &&
        candidate['payload'] !== null &&
        !Array.isArray(candidate['payload'])
          ? (candidate['payload'] as Record<string, unknown>)
          : null;
      const correlation =
        payload !== null &&
        typeof payload['requestId'] === 'string' &&
        payload['requestId'].length > 0 &&
        Number.isInteger(payload['revision']) &&
        (payload['revision'] as number) >= 0
          ? { requestId: payload['requestId'], revision: payload['revision'] as number }
          : {};
      this.sendTo(socket, {
        type: 'error',
        payload: { message: 'Unrecognised message.', ...correlation },
      });
      return;
    }

    const message: ClientToServerMessage = parsed;
    if (
      message.type === 'startGame' ||
      message.type === 'startCardTestScenario' ||
      message.type === 'resumeGame'
    ) {
      // The connection's declaration, read afresh from each of the messages that carry one.
      this.capabilities.set(socket, { ...message.payload.capabilities });
    }
    switch (message.type) {
      case 'startCardTestScenario':
        if (this.deps.cardTestLab !== true) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Card Test Lab is not enabled on this server.' },
          });
          return;
        }
        // A disconnected lab viewer must be able to replace the completed scenario. Keep the
        // takeover guard only while another browser is still attached as the active player.
        if (this.holdsPlayerSeat(socket) && this.playerSocket !== null) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Resume the active player session before replacing it.' },
          });
          return;
        }
        if (this.startingGame || this.batchActive()) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'A game is already starting or a batch is running.' },
          });
          return;
        }
        this.startCardTestScenario(socket, message.payload.scenarioId);
        return;

      case 'startGame':
        if (this.holdsPlayerSeat(socket)) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Resume the active player session before replacing it.' },
          });
          return;
        }
        if (this.startingGame || this.batchActive()) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'A game is already starting or a batch is running.' },
          });
          return;
        }
        this.startingGame = true;
        this.startingSocket = socket;
        try {
          await this.startGame(socket, message.payload);
        } catch (error) {
          // A thrown setup error is the one path that never reached the single-player
          // projection, and its message is upstream free text (a failed snapshot load names
          // the cards it could not load). A requester holding one seat gets the fixed line.
          this.sendTo(socket, {
            type: 'error',
            payload: {
              message: holdsOneSeat(message.payload.gameMode ?? 'spectator')
                ? SETUP_REFUSED_MESSAGE
                : error instanceof Error
                  ? error.message
                  : String(error),
            },
          });
        } finally {
          this.startingGame = false;
          this.startingSocket = null;
        }
        return;

      case 'jumpToTurn':
        this.requireSession(socket)?.jumpToTurn(message.payload.turn, message.payload.sequence);
        return;

      case 'setPlaybackMode':
        this.requireSession(socket)?.setPlaybackMode(message.payload.mode, message.payload.paceMs);
        return;

      case 'resolveHeldDecision':
        this.requireSession(socket)?.resolveHeldDecision(
          message.payload.requestId,
          message.payload.actionId,
          message.payload.targets,
        );
        return;

      case 'abandonGame':
        if (socket === this.startingSocket) {
          this.startGeneration++;
          if (this.session === null) return;
        }
        this.cancelOrphanTimer();
        {
          const session = this.requireSession(socket);
          if (session !== null) this.cancelPlayerIdleTimer();
          if (session === null) return;
          this.startGeneration++;
          session.abandon();
        }
        this.session = null;
        this.playerSocket = null;
        this.playerSeat = null;
        this.sessionToken = null;
        this.startedPayload = null;
        this.reportSources = null;
        return;

      case 'setDebugFlags':
        this.requireSession(socket)?.setDebugFlags(message.payload.flags);
        return;

      case 'submitPlayerAction':
        if (socket !== this.playerSocket) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Only the active player connection may submit this action.' },
          });
          return;
        }
        this.withPlayerSeat(socket, (session, seat) => {
          session.submitPlayerAction(seat, message.payload);
        });
        return;

      case 'yieldPlayerAbility':
        if (socket !== this.playerSocket) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Only the active player connection may yield an ability.' },
          });
          return;
        }
        this.withPlayerSeat(socket, (session, seat) => {
          session.yieldPlayerAbility(seat, message.payload);
        });
        return;

      case 'resumePlayerAbility':
        if (socket !== this.playerSocket) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Only the active player connection may restore an ability.' },
          });
          return;
        }
        this.withPlayerSeat(socket, (session, seat) => {
          session.resumePlayerAbility(seat, message.payload.key);
        });
        return;

      case 'cancelYield':
        if (socket !== this.playerSocket) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Only the active player connection may cancel a yield.' },
          });
          return;
        }
        this.withPlayerSeat(socket, (session, seat) => {
          session.cancelYield(seat);
        });
        return;

      case 'proposeDeal':
      case 'answerDeal':
      case 'draftDeal': {
        if (socket !== this.playerSocket) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Only the active player connection may negotiate.' },
          });
          return;
        }
        const session = this.requireSession(socket);
        const seat = this.playerSeat;
        if (session === null || seat === null) return;
        if (message.type === 'proposeDeal') session.proposeDeal(seat, message.payload);
        else if (message.type === 'answerDeal') session.answerDeal(seat, message.payload);
        else await session.draftDeal(seat, message.payload);
        return;
      }

      case 'resumeGame':
        if (
          this.session === null ||
          !resumable(this.session.getGameMode()) ||
          this.sessionToken === null ||
          message.payload.sessionToken !== this.sessionToken
        ) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'That single-player session is unavailable.' },
          });
          return;
        }
        this.playerSocket = socket;
        this.cancelPlayerIdleTimer();
        // The resuming connection's own declaration, before anything is resent to it.
        if (this.playerSeat !== null) {
          this.session.setRawActionData(this.playerSeat, this.wantsRawActionData(socket));
        }
        if (this.startedPayload !== null) {
          this.sendTo(socket, {
            type: 'gameStarted',
            payload: {
              ...this.startedPayload,
              paceMs: this.session.getLivePaceMs(),
            },
          });
        }
        if (this.playerSeat !== null) this.session.setPlayerConnected(this.playerSeat, true);
        return;
    }
  }

  /**
   * Whether a single-player game in progress belongs to a connection other than `socket`. Only
   * its own player may replace it; once the game is over there is nothing left to protect, so
   * any local connection may start the next one.
   */
  private holdsPlayerSeat(socket: C): boolean {
    const session = this.session;
    if (session === null) return false;
    const mode = session.getGameMode();
    switch (mode) {
      case 'singlePlayer':
        return !session.isOver() && socket !== this.playerSocket;
      case 'spectator':
        return false;
      case 'table':
        // flow: unreachable, the host refuses table games
        return false;
      default:
        return assertNever(mode, 'player seat guard');
    }
  }

  protected onSocketOpen(socket: C): void {
    this.sockets.add(socket);
    this.cancelOrphanTimer();
  }

  protected onSocketClose(socket: C): void {
    this.sockets.delete(socket);
    if (socket === this.startingSocket) this.startGeneration++;
    if (socket === this.playerSocket) {
      this.playerSocket = null;
      if (this.playerSeat !== null) this.session?.setPlayerConnected(this.playerSeat, false);
      this.startPlayerIdleTimer();
    }
    const mode = this.session?.getGameMode();
    switch (mode) {
      case 'singlePlayer':
        return;
      case 'table':
        // flow: unreachable, the host refuses table games
        return;
      case undefined:
      case 'spectator':
        break;
      default:
        assertNever(mode, 'orphan timer');
    }
    if (this.sockets.size === 0) this.startOrphanTimer();
  }

  /**
   * The player's browser went away. A single-player game is kept so that browser can resume it,
   * and meanwhile every other connection is refused the seat — so if the player never returns
   * (a closed private window, cleared storage), nothing could start a new game until a restart.
   * Abandon it after `PLAYER_IDLE_GRACE_MS` without a player. Resuming cancels this.
   */
  private startPlayerIdleTimer(): void {
    this.cancelPlayerIdleTimer();
    const session = this.session;
    if (session === null) return;
    const mode = session.getGameMode();
    switch (mode) {
      case 'singlePlayer':
        break;
      case 'spectator':
        return;
      case 'table':
        // flow: unreachable, the host refuses table games
        return;
      default:
        assertNever(mode, 'player idle timer');
    }
    this.playerIdleTimer = setTimeout(() => {
      this.playerIdleTimer = null;
      if (this.session !== session || this.playerSocket !== null) return;
      session.abandon();
      this.session = null;
      this.playerSeat = null;
      this.sessionToken = null;
      this.startedPayload = null;
      this.reportSources = null;
    }, PLAYER_IDLE_GRACE_MS);
    this.playerIdleTimer.unref?.();
  }

  private cancelPlayerIdleTimer(): void {
    if (this.playerIdleTimer === null) return;
    clearTimeout(this.playerIdleTimer);
    this.playerIdleTimer = null;
  }

  /**
   * Nobody is watching. Give the viewer `ORPHAN_GRACE_MS` to come back — a reload takes well under
   * a second — then abandon the match so it stops computing and its row is closed out as
   * `abandoned` rather than left reading `running`.
   */
  private startOrphanTimer(): void {
    this.cancelOrphanTimer();
    if (this.session === null) return;
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      if (this.sockets.size > 0) return;
      this.session?.abandon();
      this.session = null;
    }, ORPHAN_GRACE_MS);
    // A pending abandon must not be the reason the process refuses to exit.
    this.orphanTimer.unref?.();
  }

  private cancelOrphanTimer(): void {
    if (this.orphanTimer === null) return;
    clearTimeout(this.orphanTimer);
    this.orphanTimer = null;
  }

  /** Run a seat-scoped call for the one connection that holds the player's seat. */
  private withPlayerSeat(socket: C, run: (session: MatchSession, seat: PlayerId) => void): void {
    const session = this.requireSession(socket);
    if (session === null) return;
    const seat = this.playerSeat;
    if (seat === null) {
      this.sendTo(socket, {
        type: 'error',
        payload: { message: 'This is not a single-player game.' },
      });
      return;
    }
    run(session, seat);
  }

  private requireSession(socket: C): MatchSession | null {
    if (this.session === null) {
      this.sendTo(socket, { type: 'error', payload: { message: 'No game is running.' } });
      return null;
    }
    const mode = this.session.getGameMode();
    // fence: only the bound player socket controls a player game; a table takes the same rule.
    switch (mode) {
      case 'singlePlayer':
      case 'table':
        if (socket !== this.playerSocket) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Resume the player session before controlling this game.' },
          });
          return null;
        }
        return this.session;
      case 'spectator':
        return this.session;
      default:
        return assertNever(mode, 'session control');
    }
  }

  /**
   * Takes the whole `startGame` payload rather than a positional parameter per field: the list
   * had already reached eight, and every new option (game mode, pace, reflection) added another
   * indistinguishable string or boolean to the call site.
   */
  private async startGame(socket: C, payload: StartGamePayload): Promise<void> {
    const generation = this.startGeneration;
    const { seats, providerKind, playbackMode, paceMs } = payload;
    const gameMode = (payload.gameMode ?? 'spectator') as GameMode;
    // Reruns use a fresh seed; the old one is still stored with its game (brief §4).
    const seed = payload.seed ?? crypto.randomUUID().slice(0, 8);

    // flow: The host never runs a table (m1 rows 402, 841); tables run only in `serve:table`.
    // The parser never admits `'table'`, so this holds the line for any caller that gets here.
    switch (gameMode) {
      case 'table':
        this.sendTo(socket, { type: 'error', payload: { message: SETUP_REFUSED_MESSAGE } });
        return;
      case 'spectator':
      case 'singlePlayer':
        break;
      default:
        assertNever(gameMode, 'start game mode');
    }

    // The seat is settled before anything can fail, because it is the authorization identity
    // for every refusal below: which diagnostics this requester may see is a function of it.
    // There is no `?? 'P1'` fallback -- inferring an identity would authorize a seat nobody
    // claimed -- and no `String()` coercion, which `isPlayerSeatId` exists to avoid.
    const seatScoped = holdsOneSeat(gameMode);
    let humanSeat: PlayerId | undefined;
    // fence: requester identity (m1 row 824).
    switch (gameMode) {
      case 'spectator':
        humanSeat = undefined;
        break;
      case 'singlePlayer':
        if (!isPlayerSeatId(payload.humanSeat)) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Human seat must be P1, P2, P3 or P4.' },
          });
          return;
        }
        humanSeat = payload.humanSeat;
        break;
      default:
        return assertNever(gameMode, 'requester identity');
    }

    if (payload.previewId !== undefined) {
      const entry = this.setupPreviews.get(payload.previewId);
      const requested = previewRequestFor(payload, seats, seed);
      if (
        !entry ||
        Date.now() - entry.createdAt > 600_000 ||
        JSON.stringify(entry.request) !== JSON.stringify(requested)
      ) {
        this.sendTo(socket, {
          type: 'error',
          payload: {
            message: 'Setup preview expired or selections changed. Preview the matchup again.',
          },
        });
        return;
      }
      const fresh = await previewMatchup(entry.request, this.setupDeps());
      if (generation !== this.startGeneration) return;
      if (fresh.blockers.length > 0) {
        // A blocker is per-seat free text and names unmodeled cards, so it leaves setup by
        // the same private-data path a `SeatProblem` does. Only a spectator sees the list.
        this.sendTo(socket, {
          type: 'error',
          payload: {
            message: testerPolicy(gameMode).rawErrorText
              ? fresh.blockers.join('\n')
              : SETUP_REFUSED_MESSAGE,
          },
        });
        return;
      }
      this.setupPreviews.delete(payload.previewId);
    }

    if (seats.length !== SEAT_COUNT) {
      this.sendTo(socket, {
        type: 'error',
        payload: { message: `Exactly ${SEAT_COUNT} seats are required; got ${seats.length}.` },
      });
      return;
    }
    // Prepare the replacement before abandoning the current game.
    const setup = await setupSeats(seats, this.setupDeps(), seed);
    if (generation !== this.startGeneration) return;
    if (!setup.ok) {
      // A spectator watches every seat, so a spectator refusal may name every failing deck.
      // A single-player requester holds one: `projectSetupProblems` rebuilds the payload from
      // an allowlist keyed on that seat instead of forwarding the other three seats.
      this.sendTo(socket, {
        type: 'error',
        payload: seatScoped
          ? projectSetupProblems(setup.problems, humanSeat)
          : {
              message: setup.problems.map((p) => `${p.seat}: ${p.message}`).join('\n'),
              deckIssues: setup.problems
                .filter((p) => p.issues.length > 0)
                .map((p) => ({ seat: p.seat, issues: p.issues })),
              unmodeledCards: setup.problems
                .filter((p) => p.unmodeledCards.length > 0)
                .map((p) => ({ seat: p.seat, cards: p.unmodeledCards })),
            },
      });
      return;
    }

    const gameId = `g-${crypto.randomUUID()}`;
    const route = routeOf(gameMode);
    const policy = testerPolicy(gameMode);
    const session = new MatchSession({
      ...(this.deps.ai !== undefined && { ai: this.deps.ai }),
      gameId,
      seed,
      seats: setup.seats,
      providerKind,
      gameMode,
      disclosure: policy,
      ...replayOption(this.replayIdentity()),
      // Optional chaining: test seams build a server without a pool.
      ...(this.deps.pool?.provisional !== undefined && { provisional: this.deps.pool.provisional }),
      ...(humanSeat !== undefined && { humanSeat }),
      store: this.deps.store,
      ...(playbackMode !== undefined && { playbackMode }),
      ...(paceMs !== undefined && { livePaceMs: paceMs }),
      ...(payload.reflectionEnabled !== undefined && {
        reflectionEnabled: payload.reflectionEnabled,
      }),
      ...(payload.diplomacy === true && { diplomacy: true }),
      send: (message) => {
        if (this.session !== session) return;
        if (route === 'player') {
          if (this.playerSocket !== null) this.sendTo(this.playerSocket, message);
        } else {
          this.broadcast(message);
        }
      },
    });
    this.session?.abandon();
    this.cancelPlayerIdleTimer();
    this.session = session;
    this.sessionToken = route === 'player' ? crypto.randomUUID() : null;
    this.playerSocket = route === 'player' ? socket : null;
    this.playerSeat = humanSeat ?? null;
    if (humanSeat !== undefined) {
      session.setRawActionData(humanSeat, this.wantsRawActionData(socket));
    }

    const startedPayload: GameStartedPayload = {
      gameId,
      seed: seedLabel(policy, seed),
      seats: disclosedSeatSummaries(
        policy,
        setup.seats.map((s) => s.summary),
        humanSeat,
      ),
      providerKind,
      gameMode,
      controllers: setup.seats.map((seat) => ({
        seat: seat.seat,
        kind: seat.seat === humanSeat ? 'human' : providerKind,
      })),
      ...(humanSeat !== undefined && { humanSeat }),
      ...(this.sessionToken !== null && { sessionToken: this.sessionToken }),
      paceMs: session.getLivePaceMs(),
      startedAt: new Date().toISOString(),
      ...(session.hasDiplomacy() && { diplomacy: true }),
    };
    this.startedPayload = startedPayload;
    this.reportSources = { sources: [...seats], cardTestScenarioId: null };
    const startedMessage: ServerToClientMessage = { type: 'gameStarted', payload: startedPayload };
    if (route === 'player') this.sendTo(socket, startedMessage);
    else this.broadcast(startedMessage);

    session.start();
  }

  /**
   * What the `games` row records about the process (ADR 0031 decision 8). Omitted when the server
   * was given no build, so a bare host in a test stores nothing it cannot name.
   */
  private replayIdentity(): ReplayIdentity | undefined {
    const build = this.deps.build;
    if (build === undefined) return undefined;
    return { cardDataSha256: this.deps.cardData?.sha256 ?? null, build };
  }

  private startCardTestScenario(socket: C, scenarioId: string): void {
    const gameId = `card-lab-${crypto.randomUUID()}` as GameStartedPayload['gameId'];
    const scenario = this.labScenario(scenarioId, gameId);
    if (scenario === null) {
      this.sendTo(socket, {
        type: 'error',
        payload: { message: `Unknown Card Test Lab scenario: ${scenarioId}` },
      });
      return;
    }

    const session = new MatchSession({
      ...(this.deps.ai !== undefined && { ai: this.deps.ai }),
      gameId,
      seed: scenario.seed,
      seats: scenario.seats,
      providerKind: 'random',
      gameMode: 'singlePlayer',
      disclosure: testerPolicy('singlePlayer'),
      humanSeat: 'P1',
      livePaceMs: 0,
      engine: scenario.engine,
      ...(scenario.decisionProviderOverrides !== undefined
        ? { decisionProviderOverrides: scenario.decisionProviderOverrides }
        : {}),
      // Deliberately no store: lab runs never enter normal game statistics.
      send: (message) => {
        if (this.session !== session) return;
        if (this.playerSocket !== null) this.sendTo(this.playerSocket, message);
      },
    });
    this.session?.abandon();
    this.cancelPlayerIdleTimer();
    this.session = session;
    this.sessionToken = crypto.randomUUID();
    this.playerSocket = socket;
    this.playerSeat = 'P1';
    session.setRawActionData('P1', this.wantsRawActionData(socket));

    const startedPayload: GameStartedPayload = {
      gameId,
      seed: seedLabel(testerPolicy('singlePlayer'), scenario.seed),
      seats: disclosedSeatSummaries(
        testerPolicy('singlePlayer'),
        scenario.seats.map((seat) => seat.summary),
        'P1',
      ),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      controllers: scenario.seats.map((seat) => ({
        seat: seat.seat,
        kind: seat.seat === 'P1' ? 'human' : 'random',
      })),
      humanSeat: 'P1',
      sessionToken: this.sessionToken,
      paceMs: 0,
      startedAt: new Date().toISOString(),
      cardTestScenario: scenario.metadata,
    };
    this.startedPayload = startedPayload;
    this.reportSources = {
      sources: scenario.seats.map(() => ({ kind: 'cardTestScenario' as const })),
      cardTestScenarioId: scenario.metadata.id,
    };
    this.sendTo(socket, { type: 'gameStarted', payload: startedPayload });
    session.start();
  }
}
