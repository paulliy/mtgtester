/**
 * The multiplayer table server (ADR 0031, plans M3 to M5).
 *
 *   bun run serve:table --dev                 # http://127.0.0.1:3002, loopback only
 *   bun run serve:table --dev --oracle-fixture packages/server/fixtures/coverage-oracle.json
 *   bun run serve:table --insecure-lan        # a LAN game; see docs/guides/table-hosting.md
 *   bun run serve:table                       # production: TLS, or behind a TLS proxy
 *
 * Outside `--dev` it refuses to start without the public origin and both allowlists, and without
 * TLS unless `--insecure-lan` (`table/config.ts`). It prints a host secret at startup: that
 * secret, and nothing else, creates a table.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { readBuildInfo } from '../build-info';
import {
  buildOracleIndex,
  buildOracleIndexFromCards,
  type OracleIndex,
} from '../cards/oracle-index';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
import { toOracleCard, type RawScryfallCard } from '../cards/scryfall';
import { GameStore } from '../db';
import { loadBannedList } from '../decks/banned';
import { loadTableConfig, publicOriginFor, type TableConfig } from '../table/config';
import { startTableServer } from '../table/table-http';
import { wireTables } from '../table/wiring';

const BULK_PATH = 'data/scryfall-oracle-cards.json';
const BANNED_PATH = 'docs/rules/commander-banned-list.md';

/** Read a card file once, hashing the exact bytes parsed (the replay's card-data identity). */
function readCards(path: string): { parsed: unknown[]; sha256: string } {
  const bytes = readFileSync(resolve(path));
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array of cards in "${path}".`);
  return { parsed, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function loadCards(config: TableConfig): {
  index: OracleIndex;
  pool: SupportedPool;
  sha256: string;
} {
  if (config.oracleFixture !== null) {
    console.log(`Loading oracle fixture from ${config.oracleFixture} ...`);
    const { parsed, sha256 } = readCards(config.oracleFixture);
    const cards = parsed as OracleCard[];
    return { index: buildOracleIndexFromCards(cards), pool: buildSupportedPool(cards), sha256 };
  }
  if (!existsSync(resolve(BULK_PATH))) {
    console.error(
      `\nMissing ${BULK_PATH}. See data/README.md for how to download the Scryfall bulk file.\n`,
    );
    process.exit(1);
  }
  console.log(`Loading oracle data from ${BULK_PATH} ...`);
  const { parsed, sha256 } = readCards(BULK_PATH);
  const raw = parsed as RawScryfallCard[];
  const cards: OracleCard[] = [];
  for (const entry of raw) {
    const card = toOracleCard(entry);
    if (card !== null) cards.push(card);
  }
  return { index: buildOracleIndex(raw), pool: buildSupportedPool(cards), sha256 };
}

function main(): void {
  const result = loadTableConfig(process.env, process.argv.slice(2));
  if (!result.ok) {
    console.error(`\nserve:table refused to start: ${result.error.message}\n`);
    process.exit(1);
  }
  const config = result.config;

  const { index, pool, sha256 } = loadCards(config);
  const banned = loadBannedList(resolve(BANNED_PATH));

  // Migrate the table database once, here, before anything else opens it: every worker's
  // `GameStore` then finds the schema in place and never races another to create it.
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = new GameStore(config.dbPath);

  const { registry, hub } = wireTables({
    config,
    index,
    pool,
    banned,
    store,
    replay: { cardDataSha256: sha256, build: readBuildInfo(process.cwd()) },
  });
  const server = startTableServer({ config, registry, hub });

  const origin = publicOriginFor(config, server.port);
  const mode = config.dev
    ? 'development mode, loopback only'
    : config.insecureLan
      ? 'LAN mode, no TLS'
      : config.tls !== null
        ? 'production, TLS'
        : 'production, behind a TLS proxy';
  console.log(`\nMTG Commander AI Simulator - table server (${mode})`);
  console.log('-'.repeat(60));
  console.log(`  Bound:          ${config.host}:${server.port}`);
  console.log(`  Invite links:   ${origin}`);
  if (!config.dev) {
    console.log(`  Allowed hosts:  ${config.allowedHosts.join(', ')}`);
    console.log(`  Allowed origins: ${config.allowedOrigins.join(', ')}`);
    if (config.trustedProxy !== null) console.log(`  Trusted proxy:  ${config.trustedProxy}`);
  }
  if (config.insecureLan) {
    console.log(
      '\n  WARNING: --insecure-lan. Traffic, seat tokens included, crosses your network\n' +
        '  unencrypted. Only peers in private address ranges are accepted. Every player is\n' +
        '  shown this.',
    );
  }
  console.log(`  Database:       ${config.dbPath}`);
  console.log(`  Web build:      ${config.webDir}`);
  console.log(`  Clock:          ${config.clock}`);
  console.log(`  Max tables:     ${config.maxTables}`);
  console.log(`  Oracle index:   ${index.size.toLocaleString()} cards`);
  console.log(`  Supported pool: ${pool.cards.length.toLocaleString()} cards`);
  console.log(`\n  Host secret (creates tables; keep it private):\n    ${registry.hostSecret}`);
  console.log(
    `\n  Create a table:\n    curl -s -X POST -H "Authorization: Bearer <secret>" ${origin}/tables\n`,
  );

  const shutdown = (): void => {
    void server.stop().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
