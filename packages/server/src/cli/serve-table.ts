/**
 * The multiplayer table server (ADR 0031, plan M3).
 *
 *   bun run serve:table --dev                 # http://127.0.0.1:3002
 *   bun run serve:table --dev --port 4000
 *   bun run serve:table --dev --oracle-fixture packages/server/fixtures/coverage-oracle.json
 *
 * Until production exposure lands (M5) the server refuses to start without `--dev`, and in
 * development mode it refuses any proxy, TLS or allowlist setting (`table/config.ts`). It prints
 * a host secret at startup: that secret, and nothing else, creates a table.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import {
  buildOracleIndex,
  buildOracleIndexFromCards,
  type OracleIndex,
} from '../cards/oracle-index';
import type { RawScryfallCard } from '../cards/scryfall';
import { GameStore } from '../db';
import { loadBannedList } from '../decks/banned';
import { loadTableConfig, publicOriginFor, type TableConfig } from '../table/config';
import { createDeckChecker } from '../table/deck-check';
import { TableRegistry } from '../table/registry';
import type { TableSessionConfig, TableSessionPort } from '../table/session-port';
import { startTableServer } from '../table/table-http';
import { TableSocketHub } from '../table/table-ws';

const BULK_PATH = 'data/scryfall-oracle-cards.json';
const BANNED_PATH = 'docs/rules/commander-banned-list.md';

function readCards(path: string): unknown[] {
  const parsed: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array of cards in "${path}".`);
  return parsed;
}

function loadIndex(config: TableConfig): OracleIndex {
  if (config.oracleFixture !== null) {
    console.log(`Loading oracle fixture from ${config.oracleFixture} ...`);
    return buildOracleIndexFromCards(readCards(config.oracleFixture) as OracleCard[]);
  }
  if (!existsSync(resolve(BULK_PATH))) {
    console.error(
      `\nMissing ${BULK_PATH}. See data/README.md for how to download the Scryfall bulk file.\n`,
    );
    process.exit(1);
  }
  console.log(`Loading oracle data from ${BULK_PATH} ...`);
  return buildOracleIndex(readCards(BULK_PATH) as RawScryfallCard[]);
}

/**
 * TODO(M3 part C): the worker-backed `TableSessionPort` and the real start configuration are built
 * separately and wired here. Until then a start attempt fails as `setupFailed`.
 */
const WIRING_PENDING = 'The table game runner is not wired into serve:table yet (plan M3 part C).';
function portFactory(): TableSessionPort {
  throw new Error(WIRING_PENDING);
}
function buildConfig(): TableSessionConfig {
  throw new Error(WIRING_PENDING);
}

function main(): void {
  const result = loadTableConfig(process.env, process.argv.slice(2));
  if (!result.ok) {
    console.error(`\nserve:table refused to start: ${result.error.message}\n`);
    process.exit(1);
  }
  const config = result.config;

  const index = loadIndex(config);
  const banned = loadBannedList(resolve(BANNED_PATH));

  // Migrate the table database once, here, before anything else opens it: every worker's
  // `GameStore` then finds the schema in place and never races another to create it.
  mkdirSync(dirname(config.dbPath), { recursive: true });
  new GameStore(config.dbPath).close();

  const registry = new TableRegistry({
    deckChecker: createDeckChecker({ index, banned }),
    maxTables: config.maxTables,
    clock: config.clock,
  });
  const hub = new TableSocketHub({ registry, portFactory, buildConfig });
  const server = startTableServer({ config, registry, hub });

  const origin = publicOriginFor(config, server.port);
  console.log(`\nMTG Commander AI Simulator - table server (development mode)`);
  console.log('-'.repeat(60));
  console.log(`  Listening:      ${origin}`);
  console.log(`  Database:       ${config.dbPath}`);
  console.log(`  Web build:      ${config.webDir}`);
  console.log(`  Clock:          ${config.clock}`);
  console.log(`  Max tables:     ${config.maxTables}`);
  console.log(`  Oracle index:   ${index.size.toLocaleString()} cards`);
  console.log(`\n  Host secret (creates tables; keep it private):\n    ${registry.hostSecret}`);
  console.log(
    `\n  Create a table:\n    curl -s -X POST -H "Authorization: Bearer <secret>" ${origin}/tables\n`,
  );
  console.log(`  Note: ${WIRING_PENDING} Games cannot start yet.\n`);

  const shutdown = (): void => {
    void server.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
