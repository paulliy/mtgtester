/**
 * The Bun HTTP + WebSocket server (brief §11). The server owns the engine and the AI calls; the
 * frontend is a view and receives pushed updates. This layer does exactly two things: translate
 * inbound frames into `MatchSession` method calls, and broadcast what the session emits.
 *
 * It holds the AI key and is the only place with network I/O, per brief §2.
 */

import {
  isClientToServerMessage,
  isPlayerSeatId,
  parseStrictJson,
  PLAYER_IDLE_GRACE_MS,
  type StrictJsonFailure,
} from '@mtg/shared';
import type {
  ClientToServerMessage,
  GameReportBuild,
  GameReportCardData,
  GameStartedPayload,
  PlayerId,
  ServerToClientMessage,
  StartGamePayload,
} from '@mtg/shared';
import type { ServerWebSocket } from 'bun';
import type { OracleIndex } from '../cards/oracle-index';
import { listKnownDecks } from '../cards/known-decks';
import type { SupportedPool } from '../cards/pool';
import type { GameStore } from '../db';
import type { BannedList } from '../decks/banned';
import type { ReportSeatSource } from '../match/report';
import { MatchSession } from '../match/session';
import { BatchManager, validateBatch } from '../batch/manager';
import { setupSeats } from '../match/setup';
import { previewMatchup, type PreviewRequest } from '../match/preview';
import { createCardTestScenario, listCardTestScenarios } from '../cards/card-test-scenarios';
import { projectSetupProblems, SETUP_REFUSED_MESSAGE } from './setup-privacy';

export interface GameServerDeps {
  pool: SupportedPool;
  index: OracleIndex;
  banned: BannedList;
  store?: GameStore | undefined;
  port?: number;
  /** Explicit opt-in for closed, unpersisted deterministic viewer scenarios. */
  cardTestLab?: boolean;
  /** The checkout this server runs from, for "Copy game report". Unknown when omitted. */
  build?: GameReportBuild;
  /** The Oracle data file this server loaded, for "Copy game report". Unknown when omitted. */
  cardData?: GameReportCardData;
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
const SETUP_PREVIEW_BODY_REJECTION =
  'Unreadable JSON body. Send well-formed JSON, each field once.';

interface SocketData {
  clientId: string;
}

/** Local UI only. Validate Host too so DNS rebinding cannot turn a foreign origin into local access. */
export function isAllowedLocalRequest(request: Request, port: number): boolean {
  const local = (url: URL): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const target = new URL(request.url);
  if (!local(target)) return false;
  const origin = request.headers.get('origin');
  if (origin === null) return true; // local CLI / same-origin GET
  try {
    const source = new URL(origin);
    return (
      source.protocol === 'http:' && local(source) && [String(port), '5173'].includes(source.port)
    );
  } catch {
    return false;
  }
}

export class GameServer {
  private readonly sockets = new Set<ServerWebSocket<SocketData>>();
  private session: MatchSession | null = null;
  private startingGame = false;
  private startingSocket: ServerWebSocket<SocketData> | null = null;
  private startGeneration = 0;
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private playerIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private playerSocket: ServerWebSocket<SocketData> | null = null;
  private sessionToken: string | null = null;
  private startedPayload: GameStartedPayload | null = null;
  /** How each seat's deck was chosen, and the lab scenario if any — for "Copy game report". */
  private reportSources: { sources: ReportSeatSource[]; cardTestScenarioId: string | null } | null =
    null;
  private readonly batchManager: BatchManager | null;
  private readonly setupPreviews = new Map<
    string,
    { request: PreviewRequest; createdAt: number }
  >();

  constructor(private readonly deps: GameServerDeps) {
    this.batchManager =
      deps.store === undefined
        ? null
        : new BatchManager({
            pool: deps.pool,
            index: deps.index,
            banned: deps.banned,
            store: deps.store,
          });
  }

  /** Broadcast to every connected spectator. One game at a time (brief §15). */
  private broadcast(message: ServerToClientMessage): void {
    const frame = JSON.stringify(message);
    for (const socket of this.sockets) {
      try {
        socket.send(frame);
      } catch {
        // A socket that died between the readyState check and the send is not an error worth
        // failing a game over; the close handler removes it.
      }
    }
  }

  private sendTo(socket: ServerWebSocket<SocketData>, message: ServerToClientMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The close callback owns connection state. A send racing with it must not fail a match.
    }
  }

  listen(): ReturnType<typeof Bun.serve> {
    const port = this.deps.port ?? 3001;
    const server = Bun.serve<SocketData, never>({
      port,
      hostname: '127.0.0.1',
      fetch: async (request, srv) => {
        const url = new URL(request.url);
        if (!isAllowedLocalRequest(request, port))
          return new Response('Forbidden origin or host', { status: 403 });
        if (url.pathname === '/ws') {
          const upgraded = srv.upgrade(request, { data: { clientId: crypto.randomUUID() } });
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
        }
        if (url.pathname === '/health') {
          return Response.json({ ok: true, poolSize: this.deps.pool.cards.length });
        }
        if (url.pathname === '/api/known-decks') {
          return Response.json({ decks: await listKnownDecks(this.deps.index, this.deps.banned) });
        }
        if (url.pathname === '/api/saved-decks' && request.method === 'GET') {
          return Response.json({
            enabled: this.deps.store !== undefined,
            decks: this.deps.store?.savedDeckOptions() ?? [],
          });
        }
        if (url.pathname === '/api/setup-preview' && request.method === 'POST') {
          return await this.handleSetupPreview(request);
        }
        if (url.pathname === '/api/game-report' && request.method === 'POST') {
          return await this.handleGameReport(request);
        }
        if (url.pathname === '/api/card-test-scenarios') {
          if (this.deps.cardTestLab !== true)
            return Response.json({ message: 'Card Test Lab is disabled.' }, { status: 404 });
          return Response.json({ scenarios: listCardTestScenarios() });
        }
        if (url.pathname === '/api/stats') {
          if (this.deps.store === undefined)
            return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          const batchId = url.searchParams.get('batchId') ?? undefined;
          return Response.json({ decks: this.deps.store.stats().deckStatistics(batchId) });
        }
        if (url.pathname === '/api/batches' && request.method === 'POST') {
          if (this.batchManager === null)
            return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          if (
            this.session !== null &&
            !['finished', 'halted', 'abandoned'].includes(this.session.runner.getStatus())
          )
            return Response.json(
              { message: 'Finish or abandon the interactive game before starting a batch.' },
              { status: 409 },
            );
          if (this.batchManager.isActive())
            return Response.json({ message: 'A batch is already running.' }, { status: 409 });
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ message: 'Malformed JSON body.' }, { status: 400 });
          }
          const validation = validateBatch(body);
          if (!validation.ok)
            return Response.json({ message: validation.message }, { status: 400 });
          if (
            this.startingGame ||
            (this.session !== null &&
              !['finished', 'halted', 'abandoned'].includes(this.session.runner.getStatus()))
          )
            return Response.json(
              { message: 'An interactive game is starting or running.' },
              { status: 409 },
            );
          try {
            const batchId = this.batchManager.start(validation.spec);
            return Response.json({ batchId }, { status: 202 });
          } catch (error) {
            return Response.json(
              { message: error instanceof Error ? error.message : String(error) },
              { status: 409 },
            );
          }
        }
        const batchMatch = /^\/api\/batches\/([^/]+)$/.exec(url.pathname);
        if (batchMatch !== null && request.method === 'GET') {
          if (this.batchManager === null)
            return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          const progress = this.batchManager.progress(decodeURIComponent(batchMatch[1] ?? ''));
          return progress === null
            ? Response.json({ message: 'Batch not found.' }, { status: 404 })
            : Response.json(progress);
        }
        const batchResultsMatch = /^\/api\/batches\/([^/]+)\/results$/.exec(url.pathname);
        if (batchResultsMatch !== null && request.method === 'GET') {
          if (this.batchManager === null)
            return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          const results = this.batchManager.results(decodeURIComponent(batchResultsMatch[1] ?? ''));
          return results === null
            ? Response.json({ message: 'Batch not found.' }, { status: 404 })
            : Response.json(results);
        }
        const batchCancelMatch = /^\/api\/batches\/([^/]+)\/cancel$/.exec(url.pathname);
        if (batchCancelMatch !== null && request.method === 'POST') {
          if (this.batchManager === null)
            return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          const cancelled = this.batchManager.cancel(decodeURIComponent(batchCancelMatch[1] ?? ''));
          return cancelled
            ? Response.json({ ok: true })
            : Response.json({ message: 'Batch is not running or was not found.' }, { status: 409 });
        }
        const annotationMatch = /^\/api\/games\/([^/]+)\/annotations$/.exec(url.pathname);
        if (annotationMatch !== null) {
          if (this.deps.store === undefined)
            return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          const gameId = decodeURIComponent(annotationMatch[1] ?? '');
          // Same lock as the debug route: in an unfinished player game this would hand the human
          // exactly the opponent reasoning the live stream is withholding (ADR 0022 §3).
          if (
            this.startedPayload?.gameId === gameId &&
            this.session?.getGameMode() === 'singlePlayer' &&
            this.session.runner.getStatus() !== 'finished'
          ) {
            return Response.json(
              { message: 'AI reasoning unlocks after the player game ends.' },
              { status: 403 },
            );
          }
          return Response.json({ annotations: this.deps.store.stats().gameAnnotations(gameId) });
        }
        const reflectionMatch = /^\/api\/games\/([^/]+)\/reflections$/.exec(url.pathname);
        if (reflectionMatch !== null) {
          if (this.deps.store === undefined)
            return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          const gameId = decodeURIComponent(reflectionMatch[1] ?? '');
          // No single-player lock here, unlike the two routes above: a reflection is only ever
          // written after the game has ended, so an unfinished game has nothing to leak.
          return Response.json({ reflections: this.deps.store.stats().gameReflections(gameId) });
        }
        const debugMatch = /^\/api\/games\/([^/]+)\/(debug|export)$/.exec(url.pathname);
        if (debugMatch !== null) {
          if (this.deps.store === undefined)
            return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          const gameId = decodeURIComponent(debugMatch[1] ?? '');
          if (
            this.startedPayload?.gameId === gameId &&
            this.session?.getGameMode() === 'singlePlayer' &&
            this.session.runner.getStatus() !== 'finished'
          ) {
            return Response.json(
              { message: 'Full debug data unlocks after the player game ends.' },
              { status: 403 },
            );
          }
          const data = this.deps.store.stats().gameDebug(gameId);
          if (data.game === null)
            return Response.json({ message: 'Game not found.' }, { status: 404 });
          return new Response(JSON.stringify(data, null, debugMatch[2] === 'export' ? 2 : 0), {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              ...(debugMatch[2] === 'export'
                ? { 'content-disposition': `attachment; filename="${gameId}.json"` }
                : {}),
            },
          });
        }
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open: (socket) => this.onSocketOpen(socket),
        close: (socket) => this.onSocketClose(socket),
        message: (socket, raw) => {
          void this.handleMessage(socket, raw);
        },
      },
    });
    return server;
  }

  /**
   * `POST /api/setup-preview`. The only setup entry point that does not arrive as a `/ws` frame,
   * so it needs the same strict read: `request.json()` resolves a repeated key by last-wins, and a
   * body carrying two different `humanSeat` values would otherwise be previewed — and cached as a
   * startable token — under whichever half the native parser kept. The raw text is therefore read
   * once and handed to `parseStrictJson` before any shape validation.
   *
   * A body that could not be read unambiguously gets one fixed message for every verdict: nothing
   * from an ambiguous text may be quoted back, and the caller is a local UI that only needs to
   * know the body was refused. The schema and seat-count refusals, the 200 shape, the preview
   * cache and the seed default below are unchanged.
   */
  private async handleSetupPreview(request: Request): Promise<Response> {
    let text: string;
    try {
      text = await request.text();
    } catch {
      return Response.json({ message: SETUP_PREVIEW_BODY_REJECTION }, { status: 400 });
    }
    const strict = parseStrictJson(text);
    if (!strict.ok)
      return Response.json({ message: SETUP_PREVIEW_BODY_REJECTION }, { status: 400 });
    const body: unknown = strict.value;
    if (!isClientToServerMessage({ type: 'startGame', payload: body }))
      return Response.json({ message: 'Invalid setup selections.' }, { status: 400 });
    const selected = body as StartGamePayload;
    if (selected.seats.length !== SEAT_COUNT)
      return Response.json({ message: 'Exactly four seats are required.' }, { status: 400 });
    const previewRequest: PreviewRequest = {
      seats: selected.seats,
      seed: selected.seed?.trim() || crypto.randomUUID().slice(0, 8),
      providerKind: selected.providerKind,
      gameMode: selected.gameMode ?? 'spectator',
      ...(selected.gameMode === 'singlePlayer' && { humanSeat: selected.humanSeat }),
    };
    const preview = await previewMatchup(previewRequest, this.deps);
    const previewId = crypto.randomUUID();
    for (const [id, entry] of this.setupPreviews)
      if (Date.now() - entry.createdAt > 600_000) this.setupPreviews.delete(id);
    if (this.setupPreviews.size >= 32)
      this.setupPreviews.delete(this.setupPreviews.keys().next().value as string);
    this.setupPreviews.set(previewId, { request: previewRequest, createdAt: Date.now() });
    return Response.json({ ...preview, previewId });
  }

  /**
   * `POST /api/game-report` with `{ sessionToken }`: the "Copy game report" payload for the
   * single-player game that token resumes. The token is the same reconnect credential `resumeGame`
   * checks, so only the player's own browser can export a live game — and the session builds the
   * report from the human seat, keeping opponents' decks hidden until the game is over. POST
   * keeps the token out of URLs and request logs.
   */
  private async handleGameReport(request: Request): Promise<Response> {
    let text: string;
    try {
      text = await request.text();
    } catch {
      return Response.json({ message: 'Unreadable request body.' }, { status: 400 });
    }
    const strict = parseStrictJson(text);
    const token =
      strict.ok &&
      typeof strict.value === 'object' &&
      strict.value !== null &&
      !Array.isArray(strict.value)
        ? (strict.value as Record<string, unknown>)['sessionToken']
        : undefined;
    if (typeof token !== 'string' || token.length === 0)
      return Response.json({ message: 'A session token is required.' }, { status: 400 });
    const session = this.session;
    if (
      session === null ||
      session.getGameMode() !== 'singlePlayer' ||
      this.sessionToken === null ||
      token !== this.sessionToken
    )
      return Response.json(
        { message: 'That single-player session is unavailable.' },
        { status: 404 },
      );
    return Response.json(
      session.gameReport({
        build: this.deps.build ?? { commit: null, branch: null, dirty: null },
        cardData: this.deps.cardData ?? { source: null, sha256: null, entries: 0 },
        startedAt: this.startedPayload?.startedAt ?? null,
        sources: this.reportSources?.sources ?? [],
        cardTestScenarioId: this.reportSources?.cardTestScenarioId ?? null,
      }),
    );
  }

  private async handleMessage(
    socket: ServerWebSocket<SocketData>,
    raw: string | Buffer,
  ): Promise<void> {
    // Every inbound frame is read strictly, before its `type` is known: choosing a parsing
    // policy from the discriminant of an already ambiguous text would be circular. A frame that
    // repeats a key has no single meaning, so nothing in it — not even `requestId` — may be
    // treated as correlation (`INBOUND_FRAME_REJECTIONS`).
    const strict = parseStrictJson(typeof raw === 'string' ? raw : raw.toString('utf8'));
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
        if (this.startingGame || this.batchManager?.isActive() === true) {
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
        if (this.startingGame || this.batchManager?.isActive()) {
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
              message:
                message.payload.gameMode === 'singlePlayer'
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
        this.requireSession(socket)?.submitPlayerAction(message.payload);
        return;

      case 'yieldPlayerAbility':
        if (socket !== this.playerSocket) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Only the active player connection may yield an ability.' },
          });
          return;
        }
        this.requireSession(socket)?.yieldPlayerAbility(message.payload);
        return;

      case 'resumePlayerAbility':
        if (socket !== this.playerSocket) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Only the active player connection may restore an ability.' },
          });
          return;
        }
        this.requireSession(socket)?.resumePlayerAbility(message.payload.key);
        return;

      case 'cancelYield':
        if (socket !== this.playerSocket) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Only the active player connection may cancel a yield.' },
          });
          return;
        }
        this.requireSession(socket)?.cancelYield();
        return;

      case 'resumeGame':
        if (
          this.session === null ||
          this.session.getGameMode() !== 'singlePlayer' ||
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
        if (this.startedPayload !== null) {
          this.sendTo(socket, {
            type: 'gameStarted',
            payload: {
              ...this.startedPayload,
              paceMs: this.session.getLivePaceMs(),
            },
          });
        }
        this.session.setPlayerConnected(true);
        return;
    }
  }

  /**
   * Whether a single-player game in progress belongs to a connection other than `socket`. Only
   * its own player may replace it; once the game is over there is nothing left to protect, so
   * any local connection may start the next one.
   */
  private holdsPlayerSeat(socket: ServerWebSocket<SocketData>): boolean {
    const session = this.session;
    return (
      session !== null &&
      session.getGameMode() === 'singlePlayer' &&
      !session.isOver() &&
      socket !== this.playerSocket
    );
  }

  private onSocketOpen(socket: ServerWebSocket<SocketData>): void {
    this.sockets.add(socket);
    this.cancelOrphanTimer();
  }

  private onSocketClose(socket: ServerWebSocket<SocketData>): void {
    this.sockets.delete(socket);
    if (socket === this.startingSocket) this.startGeneration++;
    if (socket === this.playerSocket) {
      this.playerSocket = null;
      this.session?.setPlayerConnected(false);
      this.startPlayerIdleTimer();
    }
    if (this.session?.getGameMode() === 'singlePlayer') return;
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
    if (session === null || session.getGameMode() !== 'singlePlayer') return;
    this.playerIdleTimer = setTimeout(() => {
      this.playerIdleTimer = null;
      if (this.session !== session || this.playerSocket !== null) return;
      session.abandon();
      this.session = null;
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

  private requireSession(socket: ServerWebSocket<SocketData>): MatchSession | null {
    if (this.session === null) {
      this.sendTo(socket, { type: 'error', payload: { message: 'No game is running.' } });
      return null;
    }
    if (this.session.getGameMode() === 'singlePlayer' && socket !== this.playerSocket) {
      this.sendTo(socket, {
        type: 'error',
        payload: { message: 'Resume the player session before controlling this game.' },
      });
      return null;
    }
    return this.session;
  }

  /**
   * Takes the whole `startGame` payload rather than a positional parameter per field: the list
   * had already reached eight, and every new option (game mode, pace, reflection) added another
   * indistinguishable string or boolean to the call site.
   */
  private async startGame(
    socket: ServerWebSocket<SocketData>,
    payload: StartGamePayload,
  ): Promise<void> {
    const generation = this.startGeneration;
    const { seats, providerKind, playbackMode, paceMs } = payload;
    const gameMode = payload.gameMode ?? 'spectator';
    // Reruns use a fresh seed; the old one is still stored with its game (brief §4).
    const seed = payload.seed ?? crypto.randomUUID().slice(0, 8);

    // The seat is settled before anything can fail, because it is the authorization identity
    // for every refusal below: which diagnostics this requester may see is a function of it.
    // There is no `?? 'P1'` fallback -- inferring an identity would authorize a seat nobody
    // claimed -- and no `String()` coercion, which `isPlayerSeatId` exists to avoid.
    const singlePlayer = gameMode === 'singlePlayer';
    if (singlePlayer && !isPlayerSeatId(payload.humanSeat)) {
      this.sendTo(socket, {
        type: 'error',
        payload: { message: 'Human seat must be P1, P2, P3 or P4.' },
      });
      return;
    }
    const humanSeat: PlayerId | undefined = singlePlayer ? payload.humanSeat : undefined;

    if (payload.previewId !== undefined) {
      const entry = this.setupPreviews.get(payload.previewId);
      const requested = {
        seats,
        seed,
        providerKind,
        gameMode: payload.gameMode ?? 'spectator',
        ...(payload.gameMode === 'singlePlayer' && { humanSeat: payload.humanSeat }),
      };
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
      const fresh = await previewMatchup(entry.request, this.deps);
      if (generation !== this.startGeneration) return;
      if (fresh.blockers.length > 0) {
        // A blocker is per-seat free text and names unmodeled cards, so it leaves setup by
        // the same private-data path a `SeatProblem` does. Only a spectator sees the list.
        this.sendTo(socket, {
          type: 'error',
          payload: { message: singlePlayer ? SETUP_REFUSED_MESSAGE : fresh.blockers.join('\n') },
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
    const setup = await setupSeats(seats, this.deps, seed);
    if (generation !== this.startGeneration) return;
    if (!setup.ok) {
      // A spectator watches every seat, so a spectator refusal may name every failing deck.
      // A single-player requester holds one: `projectSetupProblems` rebuilds the payload from
      // an allowlist keyed on that seat instead of forwarding the other three seats.
      this.sendTo(socket, {
        type: 'error',
        payload: singlePlayer
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
    const session = new MatchSession({
      gameId,
      seed,
      seats: setup.seats,
      providerKind,
      gameMode,
      ...(humanSeat !== undefined && { humanSeat }),
      store: this.deps.store,
      ...(playbackMode !== undefined && { playbackMode }),
      ...(paceMs !== undefined && { livePaceMs: paceMs }),
      ...(payload.reflectionEnabled !== undefined && {
        reflectionEnabled: payload.reflectionEnabled,
      }),
      send: (message) => {
        if (this.session !== session) return;
        if (gameMode === 'singlePlayer') {
          if (this.playerSocket !== null) this.sendTo(this.playerSocket, message);
        } else {
          this.broadcast(message);
        }
      },
    });
    this.session?.abandon();
    this.cancelPlayerIdleTimer();
    this.session = session;
    this.sessionToken = gameMode === 'singlePlayer' ? crypto.randomUUID() : null;
    this.playerSocket = gameMode === 'singlePlayer' ? socket : null;

    const startedPayload: GameStartedPayload = {
      gameId,
      seed,
      seats: setup.seats.map((s) => s.summary),
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
    };
    this.startedPayload = startedPayload;
    this.reportSources = { sources: [...seats], cardTestScenarioId: null };
    const startedMessage: ServerToClientMessage = { type: 'gameStarted', payload: startedPayload };
    if (gameMode === 'singlePlayer') this.sendTo(socket, startedMessage);
    else this.broadcast(startedMessage);

    session.start();
  }

  private startCardTestScenario(socket: ServerWebSocket<SocketData>, scenarioId: string): void {
    const gameId = `card-lab-${crypto.randomUUID()}` as GameStartedPayload['gameId'];
    const scenario = createCardTestScenario(scenarioId, gameId);
    if (scenario === null) {
      this.sendTo(socket, {
        type: 'error',
        payload: { message: `Unknown Card Test Lab scenario: ${scenarioId}` },
      });
      return;
    }

    const session = new MatchSession({
      gameId,
      seed: scenario.seed,
      seats: scenario.seats,
      providerKind: 'random',
      gameMode: 'singlePlayer',
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

    const startedPayload: GameStartedPayload = {
      gameId,
      seed: scenario.seed,
      seats: scenario.seats.map((seat) => seat.summary),
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
