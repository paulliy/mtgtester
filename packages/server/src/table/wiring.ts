/**
 * The table server's moving parts, assembled once (plan M3 task 3). `serve:table` uses this, and
 * so does the scripted end-to-end run, so both start games the same way: a worker per attempt,
 * a manifest written before the worker starts, the attempt's end committed before anything
 * post-game unlocks, and approved decks stored under table-scoped ids.
 *
 * Bun runtime only: it opens the table database and spawns worker threads.
 */

import type { OracleIndex } from '../cards/oracle-index';
import type { SupportedPool } from '../cards/pool';
import type { GameStore } from '../db';
import type { TableAttemptManifest } from '../db/tables';
import type { BannedList } from '../decks/banned';
import type { ReplayIdentity } from '../match/replay-config';
import type { TableConfig } from './config';
import { createDeckChecker } from './deck-check';
import { createPostGameReader } from './post-game';
import { TableRegistry } from './registry';
import type { TableSessionConfig } from './session-port';
import { buildSessionConfig } from './start-config';
import { DEFAULT_HEALTH, TableSocketHub, type HealthOptions } from './table-ws';
import { workerCardsFor } from './worker-cards';
import { spawnTableWorker, WorkerSessionPort, type WorkerLike } from './worker-port';

export interface TableWiringDeps {
  config: TableConfig;
  index: OracleIndex;
  pool: SupportedPool;
  banned: BannedList;
  /** The main thread's connection to the already-migrated table database. */
  store: GameStore;
  replay: ReplayIdentity;
  /** Tests: a different worker. Defaults to `table-worker.ts` on a real thread. */
  spawn?: () => WorkerLike;
  health?: HealthOptions;
}

export interface TableWiring {
  registry: TableRegistry;
  hub: TableSocketHub;
}

export function wireTables(deps: TableWiringDeps): TableWiring {
  const { config, store } = deps;
  const tables = store.tables();
  const registry = new TableRegistry({
    deckChecker: createDeckChecker({ index: deps.index, banned: deps.banned }),
    maxTables: config.maxTables,
    clock: config.clock,
    // Every player sees the no-TLS banner at an --insecure-lan table (plan M5 task 5).
    insecureLan: config.insecureLan,
    ...(config.hostSecret !== null && { hostSecret: config.hostSecret }),
  });
  const cardsFor = workerCardsFor({ index: deps.index, pool: deps.pool, banned: deps.banned });

  const buildConfig = (attempt: Parameters<typeof buildSessionConfig>[0]): TableSessionConfig => {
    const built = buildSessionConfig(attempt, {
      dbPath: config.dbPath,
      dev: config.dev,
      ...(config.testRngKey !== null && { testRngKey: config.testRngKey }),
      ...(config.turnCap !== null && { turnCap: config.turnCap }),
      ...(config.paceMs !== null && { livePaceMs: config.paceMs }),
      ...(config.oracleFixture !== null && { oracleFixture: true }),
      clock: config.clock,
      ...(config.clockScale !== null && { clockScale: config.clockScale }),
    });
    // Development mode can shrink the engine's budget to force a halt (end-to-end tests).
    const session =
      config.maxStepWork === null ? built : { ...built, maxStepWork: config.maxStepWork };
    // The manifest is committed before the worker exists, so a worker that never reaches game
    // start still leaves a record of what was approved and which key was drawn.
    const manifest: TableAttemptManifest = {
      tableId: session.tableId,
      attemptId: session.attemptId,
      gameId: session.gameId,
      rngKey: session.rngKey,
      seats: session.seats,
      limits: {
        maxStepWork: session.maxStepWork,
        maxObjects: session.maxObjects,
        turnCap: session.turnCap ?? null,
      },
      identity: {
        cardDataSha256: deps.replay.cardDataSha256,
        buildCommit: deps.replay.build.commit,
        buildDirty: deps.replay.build.dirty,
      },
    };
    tables.beginAttempt(manifest);
    return session;
  };

  const hub = new TableSocketHub({
    registry,
    portFactory: (generation) =>
      new WorkerSessionPort({
        generation,
        spawn: deps.spawn ?? spawnTableWorker,
        cardsFor,
        replay: deps.replay,
      }),
    buildConfig,
    onDeckApproved: (tableId, approved) => {
      tables.saveApprovedDeck({ tableId, ...approved });
    },
    onAttemptEnded: ({ attemptId }, status) => {
      tables.endAttempt(attemptId, status);
    },
    postGame: createPostGameReader(store),
    health: deps.health ?? DEFAULT_HEALTH,
  });
  return { registry, hub };
}
