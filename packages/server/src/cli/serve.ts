/**
 * The spectator server (brief §11, Phase 4).
 *
 *   bun run serve                 # http://localhost:3001, WebSocket at /ws
 *   bun run serve --port 4000
 *   bun run serve --no-db         # run without persisting games (nothing is scrubbable
 *                                 # beyond what is in memory, and imports are unavailable)
 *
 * The Vue dev server (`bun run dev:web`) proxies `/ws` here, so both run side by side.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { buildOracleIndex, type OracleIndex } from '../cards/oracle-index';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
import { toOracleCard, type RawScryfallCard } from '../cards/scryfall';
import { GameStore } from '../db';
import { loadBannedList, type BannedList } from '../decks/banned';
import { GameServer } from '../ws/server';

const BULK_PATH = 'data/scryfall-oracle-cards.json';
const DB_PATH = 'data/mtg.sqlite';
const BANNED_PATH = 'docs/rules/commander-banned-list.md';

interface Args {
  port: number;
  db: boolean;
  cardTestLab: boolean;
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 3001, db: true, cardTestLab: false, dbPath: DB_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') args.port = Number.parseInt(argv[++i] ?? '3001', 10);
    else if (arg === '--db-path') args.dbPath = argv[++i] ?? DB_PATH;
    else if (arg === '--no-db') args.db = false;
    else if (arg === '--card-test-lab') {
      args.cardTestLab = true;
      args.db = false;
    }
  }
  return args;
}

function loadCards(cardTestLab: boolean): { pool: SupportedPool; index: OracleIndex } {
  if (cardTestLab) {
    return { pool: buildSupportedPool([]), index: buildOracleIndex([]) };
  }
  const path = resolve(BULK_PATH);
  if (!existsSync(path)) {
    console.error(
      `\nMissing ${BULK_PATH}. See data/README.md for how to download the Scryfall bulk file.\n`,
    );
    process.exit(1);
  }

  console.log(`Loading oracle data from ${BULK_PATH} …`);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array in "${BULK_PATH}".`);
  const raw = parsed as RawScryfallCard[];

  const cards: OracleCard[] = [];
  for (const entry of raw) {
    const card = toOracleCard(entry);
    if (card !== null) cards.push(card);
  }

  return { pool: buildSupportedPool(cards), index: buildOracleIndex(raw) };
}

function loadBanned(): BannedList {
  return loadBannedList(resolve(BANNED_PATH));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { pool, index } = loadCards(args.cardTestLab);
  const banned = loadBanned();

  let store: GameStore | undefined;
  if (args.db) {
    mkdirSync(dirname(resolve(args.dbPath)), { recursive: true });
    store = new GameStore(resolve(args.dbPath));
  }

  const server = new GameServer({
    pool,
    index,
    banned,
    store,
    port: args.port,
    cardTestLab: args.cardTestLab,
  });
  const handle = server.listen();
  // Recover only after acquiring the port: a failed second launch must not close live work.
  store?.batches().recoverInterrupted();

  console.log(`\nMTG Commander AI Simulator — spectator server`);
  console.log('─'.repeat(45));
  console.log(`  HTTP/WS:        http://localhost:${handle.port}  (WebSocket at /ws)`);
  console.log(`  Supported pool: ${pool.cards.length.toLocaleString()} cards`);
  console.log(`  Oracle index:   ${index.size.toLocaleString()} cards`);
  console.log(`  Database:       ${args.db ? args.dbPath : '(disabled)'}`);
  console.log(`  Card Test Lab:  ${args.cardTestLab ? 'enabled' : 'disabled'}`);
  console.log(`\n  Start the UI with: bun run dev:web\n`);
}

main();
