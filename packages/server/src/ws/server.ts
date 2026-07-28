/**
 * The Bun HTTP + WebSocket server (brief §11). The server owns the engine and the AI calls; the
 * frontend is a view and receives pushed updates. This layer does exactly two things: translate
 * inbound frames into `MatchSession` method calls, and broadcast what the session emits.
 *
 * It holds the AI key and is the only place with network I/O, per brief §2.
 */

import { isClientToServerMessage } from '@mtg/shared';
import type {
  ClientToServerMessage,
  GameMode,
  GameStartedPayload,
  PlaybackMode,
  ProviderKind,
  SeatSource,
  ServerToClientMessage,
} from '@mtg/shared';
import type { ServerWebSocket } from 'bun';
import type { OracleIndex } from '../cards/oracle-index';
import type { SupportedPool } from '../cards/pool';
import type { GameStore } from '../db';
import type { BannedList } from '../decks/banned';
import { MatchSession } from '../match/session';
import { setupSeats } from '../match/setup';

export interface GameServerDeps {
  pool: SupportedPool;
  index: OracleIndex;
  banned: BannedList;
  store?: GameStore | undefined;
  port?: number;
}

/** Four seats in v1; the count is a parameter, but only four is supported and tested (§15). */
const SEAT_COUNT = 4;

/**
 * How long a match survives with nobody watching. A page reload drops the socket for a moment and
 * must not kill the game; a spectator who closed the tab must not leave one running, holding an
 * engine and a `games` row that reads `running` forever.
 */
export const ORPHAN_GRACE_MS = 30_000;

interface SocketData {
  clientId: string;
}

export class GameServer {
  private readonly sockets = new Set<ServerWebSocket<SocketData>>();
  private session: MatchSession | null = null;
  private nextGameNum = 1;
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private playerSocket: ServerWebSocket<SocketData> | null = null;
  private sessionToken: string | null = null;
  private startedPayload: GameStartedPayload | null = null;

  constructor(private readonly deps: GameServerDeps) {}

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
      fetch: (request, srv) => {
        const url = new URL(request.url);
        if (url.pathname === '/ws') {
          const upgraded = srv.upgrade(request, { data: { clientId: crypto.randomUUID() } });
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
        }
        if (url.pathname === '/health') {
          return Response.json({ ok: true, poolSize: this.deps.pool.cards.length });
        }
        if (url.pathname === '/api/stats') {
          if (this.deps.store === undefined) return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          return Response.json({ decks: this.deps.store.stats().deckStatistics() });
        }
        const debugMatch = /^\/api\/games\/([^/]+)\/(debug|export)$/.exec(url.pathname);
        if (debugMatch !== null) {
          if (this.deps.store === undefined) return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
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
          if (data.game === null) return Response.json({ message: 'Game not found.' }, { status: 404 });
          return new Response(JSON.stringify(data, null, debugMatch[2] === 'export' ? 2 : 0), {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              ...(debugMatch[2] === 'export' ? { 'content-disposition': `attachment; filename="${gameId}.json"` } : {}),
            },
          });
        }
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open: (socket) => {
          this.sockets.add(socket);
          this.cancelOrphanTimer();
        },
        close: (socket) => {
          this.sockets.delete(socket);
          if (socket === this.playerSocket) {
            this.playerSocket = null;
            this.session?.setPlayerConnected(false);
          }
          if (this.session?.getGameMode() === 'singlePlayer') return;
          if (this.sockets.size === 0) this.startOrphanTimer();
        },
        message: (socket, raw) => {
          void this.handleMessage(socket, raw);
        },
      },
    });
    return server;
  }

  private async handleMessage(
    socket: ServerWebSocket<SocketData>,
    raw: string | Buffer,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      this.sendTo(socket, { type: 'error', payload: { message: 'Malformed JSON frame.' } });
      return;
    }

    // A socket frame is never trusted; the union is erased at runtime (brief §11).
    if (!isClientToServerMessage(parsed)) {
      this.sendTo(socket, { type: 'error', payload: { message: 'Unrecognised message.' } });
      return;
    }

    const message: ClientToServerMessage = parsed;
    switch (message.type) {
      case 'startGame':
        if (
          this.session?.getGameMode() === 'singlePlayer' &&
          socket !== this.playerSocket
        ) {
          this.sendTo(socket, {
            type: 'error',
            payload: { message: 'Resume the active player session before replacing it.' },
          });
          return;
        }
        await this.startGame(
          socket,
          message.payload.seats,
          message.payload.providerKind,
          message.payload.seed,
          message.payload.playbackMode,
          message.payload.paceMs,
          message.payload.gameMode,
          message.payload.humanSeat,
        );
        return;

      case 'jumpToTurn':
        this.requireSession(socket)?.jumpToTurn(message.payload.turn, message.payload.sequence);
        return;

      case 'setPlaybackMode':
        this.requireSession(socket)?.setPlaybackMode(
          message.payload.mode,
          message.payload.paceMs,
        );
        return;

      case 'resolveHeldDecision':
        this.requireSession(socket)?.resolveHeldDecision(
          message.payload.requestId,
          message.payload.actionId,
          message.payload.targets,
        );
        return;

      case 'abandonGame':
        this.cancelOrphanTimer();
        {
          const session = this.requireSession(socket);
          if (session === null) return;
          session.abandon();
        }
        this.session = null;
        this.playerSocket = null;
        this.sessionToken = null;
        this.startedPayload = null;
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

  private async startGame(
    socket: ServerWebSocket<SocketData>,
    seats: readonly SeatSource[],
    providerKind: ProviderKind,
    requestedSeed?: string,
    playbackMode?: PlaybackMode,
    paceMs?: number,
    requestedMode?: GameMode,
    requestedHumanSeat?: string,
  ): Promise<void> {
    // Reruns use a fresh seed; the old one is still stored with its game (brief §4).
    const seed = requestedSeed ?? crypto.randomUUID().slice(0, 8);

    if (seats.length !== SEAT_COUNT) {
      this.sendTo(socket, {
        type: 'error',
        payload: { message: `Exactly ${SEAT_COUNT} seats are required; got ${seats.length}.` },
      });
      return;
    }
    const gameMode = requestedMode ?? 'spectator';
    const humanSeat = gameMode === 'singlePlayer' ? (requestedHumanSeat ?? 'P1') : undefined;
    if (
      gameMode === 'singlePlayer' &&
      !['P1', 'P2', 'P3', 'P4'].includes(humanSeat as string)
    ) {
      this.sendTo(socket, {
        type: 'error',
        payload: { message: `Human seat must be P1-P4; got ${String(humanSeat)}.` },
      });
      return;
    }

    // Abandon any game still running — one at a time (brief §15).
    this.session?.abandon();

    const setup = await setupSeats(seats, this.deps, seed);
    if (!setup.ok) {
      this.sendTo(socket, {
        type: 'error',
        payload: {
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

    const gameId = `g${this.nextGameNum++}-${seed}`;
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
      send: (message) => {
        if (gameMode === 'singlePlayer') {
          if (this.playerSocket !== null) this.sendTo(this.playerSocket, message);
        } else {
          this.broadcast(message);
        }
      },
    });
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
    const startedMessage: ServerToClientMessage = { type: 'gameStarted', payload: startedPayload };
    if (gameMode === 'singlePlayer') this.sendTo(socket, startedMessage);
    else this.broadcast(startedMessage);

    session.start();
  }
}
