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
    socket.send(JSON.stringify(message));
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
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open: (socket) => {
          this.sockets.add(socket);
          this.cancelOrphanTimer();
        },
        close: (socket) => {
          this.sockets.delete(socket);
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
        await this.startGame(socket, message.payload.seats, message.payload.providerKind, message.payload.seed);
        if (this.session !== null && message.payload.playbackMode !== undefined) {
          this.session.setPlaybackMode(message.payload.playbackMode);
        }
        return;

      case 'jumpToTurn':
        this.requireSession(socket)?.jumpToTurn(message.payload.turn, message.payload.sequence);
        return;

      case 'setPlaybackMode':
        this.requireSession(socket)?.setPlaybackMode(message.payload.mode);
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
        this.requireSession(socket)?.abandon();
        this.session = null;
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
    }
    return this.session;
  }

  private async startGame(
    socket: ServerWebSocket<SocketData>,
    seats: readonly SeatSource[],
    providerKind: ProviderKind,
    requestedSeed?: string,
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
      store: this.deps.store,
      send: (message) => {
        this.broadcast(message);
      },
    });
    this.session = session;

    this.broadcast({
      type: 'gameStarted',
      payload: {
        gameId,
        seed,
        seats: setup.seats.map((s) => s.summary),
        providerKind,
        startedAt: new Date().toISOString(),
      },
    });

    session.start();
  }
}
