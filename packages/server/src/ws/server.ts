/**
 * The Bun HTTP + WebSocket server (brief §11). The server owns the engine and the AI calls; the
 * frontend is a view and receives pushed updates. The game logic lives in `GameHost`
 * (`host/game-host.ts`), which a browser worker runs too; this layer adds the sockets, the HTTP
 * routes, and what only the server runs: batches, statistics and the Card Test Lab.
 *
 * It holds the AI key and is the only place with network I/O, per brief §2.
 */

import type { GameStartedPayload } from '@mtg/shared';
import type { ServerWebSocket } from 'bun';
import { listKnownDecks } from '../cards/known-decks';
import {
  createCardTestScenario,
  listCardTestScenarios,
  type CardTestScenario,
} from '../cards/card-test-scenarios';
import { BatchManager, validateBatch } from '../batch/manager';
import { sessionAi } from '../match/session-ai';
import {
  GameHost,
  SETUP_PREVIEW_BODY_REJECTION,
  type GameHostDeps,
  type HostReply,
} from '../host/game-host';

export { ORPHAN_GRACE_MS } from '../host/game-host';

export interface GameServerDeps extends Omit<GameHostDeps, 'ai'> {
  port?: number;
}

interface SocketData {
  clientId: string;
}

const reply = ({ status, body }: HostReply): Response => Response.json(body, { status });

/** Local UI only. Validate Host too so DNS rebinding cannot turn a foreign origin into local access. */
export function isAllowedLocalRequest(
  request: Request,
  port: number,
  cardTestLab = false,
  configuredLabWebPort?: string,
): boolean {
  const local = (url: URL): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const target = new URL(request.url);
  if (!local(target)) return false;
  const origin = request.headers.get('origin');
  if (origin === null) return true; // local CLI / same-origin GET
  try {
    const source = new URL(origin);
    const labWebPort = Number(configuredLabWebPort);
    const allowedPorts = [String(port), '5173'];
    if (
      cardTestLab &&
      configuredLabWebPort !== undefined &&
      Number.isInteger(labWebPort) &&
      labWebPort >= 1 &&
      labWebPort <= 65535
    ) {
      allowedPorts.push(String(labWebPort));
    }
    return source.protocol === 'http:' && local(source) && allowedPorts.includes(source.port);
  } catch {
    return false;
  }
}

export class GameServer extends GameHost<ServerWebSocket<SocketData>> {
  private readonly batchManager: BatchManager | null;

  constructor(private readonly serverDeps: GameServerDeps) {
    super({ ...serverDeps, ai: sessionAi });
    this.batchManager =
      serverDeps.store === undefined
        ? null
        : new BatchManager({
            pool: serverDeps.pool,
            index: serverDeps.index,
            banned: serverDeps.banned,
            store: serverDeps.store,
          });
  }

  protected override batchActive(): boolean {
    return this.batchManager?.isActive() === true;
  }

  protected override labScenario(
    scenarioId: string,
    gameId: GameStartedPayload['gameId'],
  ): CardTestScenario | null {
    return createCardTestScenario(scenarioId, gameId);
  }

  /** `POST /api/setup-preview`. The body is read as text so the host can parse it strictly. */
  private async handleSetupPreview(request: Request): Promise<Response> {
    let text: string;
    try {
      text = await request.text();
    } catch {
      return Response.json({ message: SETUP_PREVIEW_BODY_REJECTION }, { status: 400 });
    }
    return reply(await this.previewSetup(text));
  }

  /** `POST /api/game-report` with `{ sessionToken }`. POST keeps the token out of URLs and logs. */
  private async handleGameReport(request: Request): Promise<Response> {
    let text: string;
    try {
      text = await request.text();
    } catch {
      return Response.json({ message: 'Unreadable request body.' }, { status: 400 });
    }
    return reply(this.gameReport(text));
  }

  listen(): ReturnType<typeof Bun.serve> {
    const port = this.serverDeps.port ?? 3001;
    const server = Bun.serve<SocketData, never>({
      port,
      hostname: '127.0.0.1',
      fetch: async (request, srv) => {
        const url = new URL(request.url);
        if (
          !isAllowedLocalRequest(
            request,
            port,
            this.deps.cardTestLab === true,
            process.env['CARD_TEST_LAB_WEB_PORT'],
          )
        )
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
          if (this.holdsUnfinishedGame(gameId)) {
            return Response.json(
              { message: 'AI reasoning unlocks after the player game ends.' },
              { status: 403 },
            );
          }
          return Response.json({ annotations: this.deps.store.stats().gameAnnotations(gameId) });
        }
        const talkMatch = /^\/api\/games\/([^/]+)\/table-talk$/.exec(url.pathname);
        if (talkMatch !== null) {
          const gameId = decodeURIComponent(talkMatch[1] ?? '');
          // Table talk is public (ADR 0035), so no single-player lock. The live session is the
          // source of truth for the running game; the store serves finished ones.
          if (this.startedPayload?.gameId === gameId && this.session !== null) {
            return Response.json({ tableTalk: this.session.tableTalk() });
          }
          if (this.deps.store === undefined)
            return Response.json({ message: 'Persistence is disabled.' }, { status: 503 });
          return Response.json({ tableTalk: this.deps.store.stats().gameTableTalk(gameId) });
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
          if (this.holdsUnfinishedGame(gameId)) {
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
}
