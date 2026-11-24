/**
 * Single player in the browser (ADR 0053): the game host inside a Web Worker. The page sends
 * protocol frames and a few requests; the worker answers with frames and replies. Everything
 * here is browser-safe, and the scope is passed in so tests can drive it without a browser.
 *
 * The worker reads the site's card files (`cards/site-cards.ts`) once, at `init`. A deck the
 * page pastes may name cards outside the pool, whose data sits in shards; before a start or a
 * preview reaches the host, the worker fetches the shards those names need, so the host's
 * synchronous card index can resolve them.
 */

import type { ParsedDeck, SeatSource } from '@mtg/shared';
import { deckCardNames, SiteCards, type FetchText } from '../cards/site-cards';
import { MemoryDeckStore } from '../db/deck-store';
import { importDeck } from '../decks/source';
import { GameHost, type HostConnection, type HostReply } from './game-host';

/** What the page sends the worker. */
export type PageToWorker =
  /** Read the card files from `cardsUrl` (a folder URL ending in `/`). Answered by `ready`. */
  | { kind: 'init'; cardsUrl: string }
  /** One protocol frame, as text, exactly as a WebSocket would carry it. */
  | { kind: 'frame'; text: string }
  /** What the server answers over HTTP: the setup preview, the game report, the bot decks. */
  | {
      kind: 'request';
      id: number;
      op: 'setupPreview' | 'gameReport' | 'knownDecks';
      body?: string;
    }
  /** A health probe, answered at once with `pong`. */
  | { kind: 'ping'; id: number }
  /** The page is leaving: a single-player game waits for a resume, as on the server. */
  | { kind: 'close' };

/** What the worker sends the page. */
export type WorkerToPage =
  | { kind: 'ready'; cards: number; pool: number; contentSha256: string }
  | { kind: 'failed'; message: string }
  | { kind: 'frame'; text: string }
  | { kind: 'reply'; id: number; status: number; body: unknown }
  | { kind: 'pong'; id: number };

/** The slice of a worker's global scope this module uses. */
export interface WorkerScope {
  postMessage(message: WorkerToPage): void;
  addEventListener(type: 'message', listener: (event: { data: PageToWorker }) => void): void;
}

export interface WorkerOptions {
  /** How to read a card file. Defaults to `fetch` against the `init` folder URL. */
  fetchText?: (cardsUrl: string) => FetchText;
}

const fetchFrom =
  (cardsUrl: string): FetchText =>
  async (path) => {
    const response = await fetch(new URL(path, cardsUrl));
    if (!response.ok) throw new Error(`Card file "${path}" answered ${response.status}.`);
    return response.text();
  };

/** Start answering the page. Messages are handled one at a time, in the order they arrive. */
export function serveWorker(scope: WorkerScope, options: WorkerOptions = {}): void {
  const page: HostConnection = {
    send: (text) => scope.postMessage({ kind: 'frame', text }),
  };
  let sites: SiteCards | null = null;
  let host: GameHost | null = null;
  let queue: Promise<void> = Promise.resolve();

  const reply = (id: number, { status, body }: HostReply): void =>
    scope.postMessage({ kind: 'reply', id, status, body });
  const notReady = (id: number): void =>
    reply(id, { status: 503, body: { message: 'The card data is still loading.' } });

  async function init(cardsUrl: string): Promise<void> {
    try {
      sites = await SiteCards.open((options.fetchText ?? fetchFrom)(cardsUrl));
      const manifest = sites.manifest;
      host = new GameHost({
        pool: sites.pool,
        // Resolves every card loaded so far; `prefetch` loads what a deck names first.
        index: await sites.indexFor([]),
        banned: sites.banned,
        decks: new MemoryDeckStore(),
        build: { commit: manifest.engine.commit, branch: null, dirty: null },
        cardData: {
          source: `site-cards/${manifest.contentSha256.slice(0, 16)}`,
          sha256: manifest.contentSha256,
          entries: manifest.counts.cards,
        },
      });
      host.open(page);
      scope.postMessage({
        kind: 'ready',
        cards: manifest.counts.cards,
        pool: manifest.counts.pool,
        contentSha256: manifest.contentSha256,
      });
    } catch (error) {
      scope.postMessage({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Load the card data every pasted decklist in `payload` names. Pool and saved seats need none. */
  async function prefetch(payload: unknown): Promise<void> {
    if (sites === null || typeof payload !== 'object' || payload === null) return;
    const seats = (payload as { seats?: unknown }).seats;
    if (!Array.isArray(seats)) return;
    const names: string[] = [];
    for (const seat of seats as SeatSource[]) {
      if (seat?.kind !== 'plaintext' || typeof seat.text !== 'string') continue;
      let parsed: ParsedDeck;
      try {
        parsed = await importDeck(seat.text);
      } catch {
        continue; // The host reports the import error itself.
      }
      names.push(...deckCardNames(parsed));
    }
    // A failed shard fetch leaves its cards unresolved; setup then names them like any miss.
    if (names.length > 0) await sites.indexFor(names).catch(() => undefined);
  }

  function framePayload(text: string): unknown {
    try {
      const value = JSON.parse(text) as { type?: unknown; payload?: unknown };
      return value?.type === 'startGame' ? value.payload : null;
    } catch {
      return null; // The host answers a malformed frame.
    }
  }

  function bodyOf(text: string | undefined): unknown {
    try {
      return text === undefined ? null : JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function handle(message: PageToWorker): Promise<void> {
    switch (message.kind) {
      case 'init':
        if (sites === null) await init(message.cardsUrl);
        return;
      case 'frame':
        if (host === null) {
          page.send(
            JSON.stringify({
              type: 'error',
              payload: { message: 'The card data is still loading.' },
            }),
          );
          return;
        }
        await prefetch(framePayload(message.text));
        await host.receive(page, message.text);
        return;
      case 'request':
        if (host === null || sites === null) return notReady(message.id);
        switch (message.op) {
          case 'setupPreview':
            await prefetch(bodyOf(message.body));
            return reply(message.id, await host.previewSetup(message.body ?? ''));
          case 'gameReport':
            return reply(message.id, host.gameReport(message.body ?? ''));
          case 'knownDecks':
            return reply(message.id, { status: 200, body: { decks: sites.decks } });
        }
        return;
      case 'close':
        host?.close(page);
        return;
      case 'ping':
        return; // Answered on arrival.
    }
  }

  scope.addEventListener('message', (event) => {
    const message = event.data;
    // A probe skips the queue: it asks whether the worker's loop is alive, not whether it is idle.
    if (message.kind === 'ping') {
      scope.postMessage({ kind: 'pong', id: message.id });
      return;
    }
    queue = queue.then(() => handle(message)).catch(() => undefined);
  });
}
