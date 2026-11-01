/**
 * The messages between the table server's main thread and one game worker (plan M3 task 3).
 * Everything here is structured-clonable: it crosses `postMessage`.
 *
 * The worker gets its card data from the main thread rather than reading the bulk file again:
 * the cards of the approved decks plus the supported pool, which is all a table game can reach.
 * The pool is sent whole so a bot's generated deck is the one the main thread's pool would give.
 */

import type { OracleCard } from '@mtg/shared';
import type { ReplayIdentity } from '../match/replay-config';
import type { TableSessionConfig, TableSessionInput, TableSessionOutput } from './session-port';

/** What a worker needs besides the attempt's configuration. */
export interface TableWorkerCards {
  /** The supported pool's cards, in the main thread's order. */
  poolCards: OracleCard[];
  /** Every card the approved human decklists resolve to. */
  deckCards: OracleCard[];
  /** The banned list's names as written in the source. */
  bannedNames: string[];
}

export interface TableWorkerBoot {
  config: TableSessionConfig;
  cards: TableWorkerCards;
  /** What the `games` row records for replay. */
  replay: ReplayIdentity;
  /** The generation of the port that owns this worker; every output carries it. */
  generation: number;
  /** SQLite `busy_timeout` for the worker's own connection, set before the schema runs. */
  busyTimeoutMs: number;
}

export type MainToWorker =
  | { type: 'boot'; boot: TableWorkerBoot }
  | { type: 'input'; input: TableSessionInput }
  | { type: 'ping'; id: number }
  | { type: 'terminate'; reason: 'workerFailure' | 'hostAbandoned' };

export type WorkerToMain =
  | { type: 'output'; output: TableSessionOutput }
  | { type: 'pong'; id: number }
  /** The worker's run has ended after `terminate`; the main thread may now stop the thread. */
  | { type: 'terminated' };
