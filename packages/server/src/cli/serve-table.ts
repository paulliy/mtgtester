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
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { readBuildInfo, readReleaseCommit } from '../build-info';
import { buildOracleIndexFromCards, type OracleIndex } from '../cards/oracle-index';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
import type { RawScryfallCard } from '../cards/scryfall';
import { convertBulkCards, loadTableCards, TABLE_CARDS_PATH } from '../cards/table-cards';
import { GameStore } from '../db';
import { loadBannedList } from '../decks/banned-file';
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
    return fromCards(parsed as OracleCard[], sha256);
  }
  // The prebuilt file (`bun run table:cards`) holds the same converted cards as the bulk file,
  // at a fraction of the size and with none of the raw Scryfall objects to parse and drop.
  if (existsSync(resolve(TABLE_CARDS_PATH))) {
    console.log(`Loading prebuilt cards from ${TABLE_CARDS_PATH} ...`);
    if (
      existsSync(resolve(BULK_PATH)) &&
      statSync(resolve(BULK_PATH)).mtimeMs > statSync(resolve(TABLE_CARDS_PATH)).mtimeMs
    ) {
      console.warn(
        `  WARNING: ${BULK_PATH} is newer than ${TABLE_CARDS_PATH}. Run \`bun run table:cards\` ` +
          'so tables use the updated cards.',
      );
    }
    const { cards, sha256 } = loadTableCards(resolve(TABLE_CARDS_PATH));
    return fromCards(cards, sha256);
  }
  if (!existsSync(resolve(BULK_PATH))) {
    console.error(
      `\nMissing ${TABLE_CARDS_PATH} and ${BULK_PATH}. Run \`bun run scryfall:update\` and then ` +
        `\`bun run table:cards\`; see data/README.md.\n`,
    );
    process.exit(1);
  }
  console.log(
    `Loading oracle data from ${BULK_PATH} ... (run \`bun run table:cards\` to start faster on less memory)`,
  );
  const { parsed, sha256 } = readCards(BULK_PATH);
  return fromCards(convertBulkCards(parsed as RawScryfallCard[]), sha256);
}

function fromCards(
  cards: OracleCard[],
  sha256: string,
): { index: OracleIndex; pool: SupportedPool; sha256: string } {
  return { index: buildOracleIndexFromCards(cards), pool: buildSupportedPool(cards), sha256 };
}

function main(): void {
  // Bun 1.3's `server.stop()` never settles once a table socket has closed, so shutdown would hang.
  if (!Bun.semver.satisfies(Bun.version, '>=1.4.3')) {
    console.error(`\nserve:table needs Bun 1.4.3 or later (this is ${Bun.version}).\n`);
    process.exit(1);
  }
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

  const build = readBuildInfo(process.cwd());
  const { registry, hub } = wireTables({
    config,
    index,
    pool,
    banned,
    store,
    replay: { cardDataSha256: sha256, build },
  });
  // `/health` names the release, so the deploy agent can confirm the new one came up.
  const version = readReleaseCommit(process.cwd()) ?? 'dev';
  const server = startTableServer({ config, registry, hub, version });

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
  console.log(`  Release:        ${version}`);
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
  if (config.hostSecret !== null) {
    // The operator chose it and it outlives this run, so it stays out of the log.
    console.log('\n  Host secret:    fixed by TABLE_HOST_SECRET (not printed)');
  } else {
    console.log(`\n  Host secret (creates tables; keep it private):\n    ${registry.hostSecret}`);
  }
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
