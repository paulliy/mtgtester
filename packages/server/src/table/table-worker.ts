/**
 * The worker entry for one table game (ADR 0031 decision 6, plan M3 task 3). Bun runtime only.
 *
 * It owns its own `GameStore` connection, its own card index and pool (built from the cards the
 * main thread sent), and one `InProcessSessionPort`, which runs the game. Its message loop
 * relays the port's outputs, forwards inputs, and answers health probes. A probe is answered by
 * this loop, not by the game, so a game waiting on a human still answers it and a game stuck in
 * a synchronous step does not.
 *
 * The main thread migrates the table database before any worker starts, and the connection here
 * sets `busy_timeout` before it runs the schema, so a busy database waits instead of failing.
 */

import { buildOracleIndexFromCards } from '../cards/oracle-index';
import type { SupportedPool } from '../cards/pool';
import { GameStore } from '../db';
import { bannedListFromNames } from '../decks/banned';
import { InProcessSessionPort } from './in-process-port';
import type { MainToWorker, TableWorkerBoot, WorkerToMain } from './worker-protocol';

declare const self: Worker;

let port: InProcessSessionPort | null = null;
let store: GameStore | null = null;
/** Set by the first boot message, so a second one is ignored while the first awaits. */
let booting = false;
/** Set by `terminate`, so a boot still loading the model services starts no game. */
let stopping = false;

function post(message: WorkerToMain): void {
  self.postMessage(message);
}

async function boot(input: TableWorkerBoot): Promise<void> {
  if (port !== null || booting) return;
  booting = true;
  const { config, cards } = input;
  // The model services cost a worker about 60 MB, so only a game with model seats loads them.
  const sessionAi =
    config.ai === undefined ? undefined : (await import('../match/session-ai')).sessionAi;
  if (stopping) return;
  store = new GameStore(config.dbPath, { busyTimeoutMs: input.busyTimeoutMs });
  const index = buildOracleIndexFromCards([
    ...cards.pool.map((entry) => entry.card),
    ...cards.deckCards,
  ]);
  // The main thread's pool, as `buildSupportedPool` would rebuild it here without interpreting
  // every card again: the worker has no provisional catalog, so provisional entries drop out, and
  // every entry is commander-legal, so each counts as considered.
  const pool: SupportedPool = {
    cards: cards.pool.filter((entry) => entry.provisional !== true),
    considered: cards.pool.length,
  };
  const session = new InProcessSessionPort({
    generation: input.generation,
    deps: {
      pool,
      index,
      banned: bannedListFromNames(cards.bannedNames),
      store,
      replay: input.replay,
      // Model seats (ADR 0055): the key comes from this worker's own environment, which it
      // inherits from the server process, and never crosses `postMessage`.
      ...(sessionAi !== undefined && {
        ai: { services: sessionAi, apiKey: process.env['ANTHROPIC_API_KEY'] ?? '' },
      }),
    },
  });
  port = session;
  session.onOutput((output) => {
    post({ type: 'output', output });
  });
  void session.start(config);
}

async function stop(reason: 'workerFailure' | 'hostAbandoned'): Promise<void> {
  stopping = true;
  const running = port;
  if (running !== null) await running.terminate(reason);
  try {
    store?.close();
  } catch {
    // The connection is going away with the thread.
  }
  store = null;
  post({ type: 'terminated' });
}

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'boot':
      void boot(message.boot);
      return;
    case 'input':
      void port?.send(message.input).catch(() => undefined);
      return;
    case 'ping':
      post({ type: 'pong', id: message.id });
      return;
    case 'terminate':
      void stop(message.reason);
      return;
    default: {
      const unknown: never = message;
      void unknown;
    }
  }
};
