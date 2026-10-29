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
import { buildSupportedPool } from '../cards/pool';
import { GameStore } from '../db';
import { bannedListFromNames } from '../decks/banned';
import { InProcessSessionPort } from './in-process-port';
import type { MainToWorker, TableWorkerBoot, WorkerToMain } from './worker-protocol';

declare const self: Worker;

let port: InProcessSessionPort | null = null;
let store: GameStore | null = null;

function post(message: WorkerToMain): void {
  self.postMessage(message);
}

function boot(input: TableWorkerBoot): void {
  if (port !== null) return;
  const { config, cards } = input;
  store = new GameStore(config.dbPath, { busyTimeoutMs: input.busyTimeoutMs });
  const index = buildOracleIndexFromCards([...cards.poolCards, ...cards.deckCards]);
  const pool = buildSupportedPool(cards.poolCards);
  const session = new InProcessSessionPort({
    generation: input.generation,
    deps: {
      pool,
      index,
      banned: bannedListFromNames(cards.bannedNames),
      store,
      replay: input.replay,
    },
  });
  port = session;
  session.onOutput((output) => {
    post({ type: 'output', output });
  });
  void session.start(config);
}

async function stop(reason: 'workerFailure' | 'hostAbandoned'): Promise<void> {
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
      boot(message.boot);
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
