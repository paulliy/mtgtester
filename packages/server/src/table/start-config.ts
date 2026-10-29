/**
 * From one accepted `hostStart` to the configuration a game worker needs (ADR 0031 decision 6,
 * plan M3 task 4). The table server persists the result as the private start-attempt manifest
 * before it hands it to a session port, so a start that never reaches game start still leaves a
 * readable record.
 *
 * Each call draws a fresh `chacha20` key. A retried start (after `setupProblems`) calls this again
 * with a new attempt and gets a new key; nothing about an earlier attempt's key is reused.
 */

import type { TableClockMode } from '@mtg/shared';
import type { StartAttempt } from './table';
import type { TableSessionConfig, TableSessionSeat } from './session-port';
import { TABLE_ENGINE_LIMITS } from '../match/engine-limits';
import { generateRngKey } from './tokens';

export interface BuildSessionConfigOptions {
  /** The table database the worker's `GameStore` opens. */
  dbPath: string;
  /** Dev mode (`--dev`): the only mode that accepts `testRngKey`. */
  dev?: boolean;
  /** Dev only: a fixed key, so end-to-end hands are reproducible. 64 hex digits. */
  testRngKey?: string;
  turnCap?: number;
  oracleFixture?: boolean;
  /** Tests only: 0 presents as fast as the engine computes. */
  livePaceMs?: number;
  /** Defaults to a fresh random id. */
  gameId?: string;
  /** The table's clock preset. Defaults to `relaxed`; `off` only in dev mode. */
  clock?: TableClockMode;
  /** Dev mode only: every clock duration divided by this. */
  clockScale?: number;
}

const KEY_PATTERN = /^[0-9a-f]{64}$/;

export function buildSessionConfig(
  attempt: StartAttempt,
  opts: BuildSessionConfigOptions,
): TableSessionConfig {
  const clock = opts.clock ?? 'relaxed';
  if (clock === 'off' && opts.dev !== true) throw new Error('an untimed table is dev mode only');
  if (opts.clockScale !== undefined && opts.dev !== true) {
    throw new Error('a clock scale is accepted only in dev mode');
  }
  let rngKey: string;
  if (opts.testRngKey !== undefined) {
    if (opts.dev !== true) throw new Error('a fixed rng key is accepted only in dev mode');
    if (!KEY_PATTERN.test(opts.testRngKey)) {
      throw new Error('the test rng key must be 64 lowercase hex digits');
    }
    rngKey = opts.testRngKey;
  } else {
    rngKey = generateRngKey();
  }

  // The worker needs the approved plaintext, never the resolved deck object.
  const seats: TableSessionSeat[] = attempt.seats.map((seat) =>
    seat.controller === 'human'
      ? {
          seat: seat.seat,
          controller: 'human',
          displayName: seat.displayName,
          decklist: seat.decklist,
        }
      : { seat: seat.seat, controller: 'bot' },
  );

  return {
    tableId: attempt.tableId,
    attemptId: attempt.attemptId,
    gameId: opts.gameId ?? crypto.randomUUID(),
    // A public label only; it decides nothing about the game.
    seed: `table-${attempt.attemptId}`,
    rngKey,
    seats,
    maxStepWork: TABLE_ENGINE_LIMITS.maxStepWork,
    maxObjects: TABLE_ENGINE_LIMITS.maxObjects,
    ...(opts.turnCap !== undefined && { turnCap: opts.turnCap }),
    clock,
    ...(opts.clockScale !== undefined && { clockScale: opts.clockScale }),
    dbPath: opts.dbPath,
    ...(opts.oracleFixture !== undefined && { oracleFixture: opts.oracleFixture }),
    ...(opts.livePaceMs !== undefined && { livePaceMs: opts.livePaceMs }),
  };
}
