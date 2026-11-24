/**
 * Single player in the browser (ADR 0053): the page's side of the game worker. The worker
 * (`packages/server/src/host/browser-worker.ts`) runs the same game host as the server and
 * speaks the same protocol frames, plus a few requests that stand in for the server's HTTP
 * routes. One worker at a time: it is started on first use and terminated to free its memory.
 *
 * Only `lib/socket.ts` and `lib/api.ts` load this module, and only in a local-games build, so
 * the server build never fetches the worker.
 */

/** What the page sends the worker (`host/worker-core.ts`, repeated so this app needs no server types). */
type PageToWorker =
  | { kind: 'init'; cardsUrl: string }
  | { kind: 'frame'; text: string }
  | { kind: 'request'; id: number; op: WorkerRequest; body?: string }
  | { kind: 'ping'; id: number };

/** What the worker sends the page. */
type WorkerToPage =
  | { kind: 'ready'; cards: number; pool: number; contentSha256: string }
  | { kind: 'failed'; message: string }
  | { kind: 'frame'; text: string }
  | { kind: 'reply'; id: number; status: number; body: unknown }
  | { kind: 'pong'; id: number };

export type WorkerRequest = 'setupPreview' | 'gameReport' | 'knownDecks';

export interface WorkerReply {
  status: number;
  body: unknown;
}

interface Running {
  worker: Worker;
  ready: Promise<void>;
  pending: Map<number, (reply: WorkerReply) => void>;
}

let running: Running | null = null;
let nextId = 1;
let frameListener: ((text: string) => void) | null = null;

/** Where the site's card files live: `VITE_CARDS_URL`, or `/cards/` on the page's own host. */
export function cardsUrl(): string {
  const configured = import.meta.env.VITE_CARDS_URL;
  const base = typeof configured === 'string' && configured.length > 0 ? configured : '/cards/';
  return new URL(base, window.location.href).href;
}

function start(): Running {
  // A real file, not a blob: the site's security policy refuses blob: workers.
  const worker = new Worker(
    new URL('../../../../packages/server/src/host/browser-worker.ts', import.meta.url),
    { type: 'module', name: 'decktank-game' },
  );
  const pending = new Map<number, (reply: WorkerReply) => void>();
  const ready = new Promise<void>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<WorkerToPage>) => {
      const message = event.data;
      switch (message.kind) {
        case 'ready':
          resolve();
          return;
        case 'failed':
          reject(new Error(message.message));
          return;
        case 'frame':
          if (running?.worker === worker) frameListener?.(message.text);
          return;
        case 'reply': {
          const done = pending.get(message.id);
          pending.delete(message.id);
          done?.({ status: message.status, body: message.body });
          return;
        }
        case 'pong':
          return;
      }
    });
    worker.addEventListener('error', (event) => {
      reject(new Error(event.message || 'The game engine could not start in this browser.'));
    });
  });
  // A failed start is reported to whoever waits on it; nobody waiting is not an error.
  ready.catch(() => undefined);
  const next: Running = { worker, ready, pending };
  running = next;
  post(next, { kind: 'init', cardsUrl: cardsUrl() });
  return next;
}

function post(target: Running, message: PageToWorker): void {
  target.worker.postMessage(message);
}

/** The running worker, started if there is none. */
function current(): Running {
  return running ?? start();
}

/**
 * Resolves once the worker has read the card files. A failure stops the worker, so the next
 * call starts a fresh one rather than waiting on a dead one forever.
 */
export async function engineReady(): Promise<void> {
  const target = current();
  try {
    await target.ready;
  } catch (reason) {
    if (running === target) stopEngine();
    throw reason;
  }
}

/** One of the requests that stand in for the server's HTTP routes. */
export async function workerRequest(op: WorkerRequest, body?: unknown): Promise<WorkerReply> {
  await engineReady();
  const target = current();
  const id = nextId++;
  return new Promise((resolve) => {
    target.pending.set(id, resolve);
    post(target, {
      kind: 'request',
      id,
      op,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  });
}

/** Receive the worker's protocol frames (one listener: the game store's transport). */
export function onFrame(listener: ((text: string) => void) | null): void {
  frameListener = listener;
}

/** Send one protocol frame. The worker queues it behind the card files if they are still loading. */
export function sendFrame(text: string): void {
  post(current(), { kind: 'frame', text });
}

/**
 * Terminate the worker and free everything it holds: the game, its history and the card index.
 * Requests still waiting are answered as unavailable. The next use starts a fresh worker, whose
 * card files come from the browser's cache.
 */
export function stopEngine(): void {
  const target = running;
  if (target === null) return;
  running = null;
  target.worker.terminate();
  for (const done of target.pending.values()) {
    done({ status: 503, body: { message: 'The game engine was restarted.' } });
  }
  target.pending.clear();
}
