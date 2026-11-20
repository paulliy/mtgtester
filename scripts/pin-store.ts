/**
 * The Oracle pin store's maintenance (ADR 0034 decision 10; `packages/engine/tests/scenario/
 * pin-store.ts` reads it).
 *
 *   bun run pin-store add "<name>" [...]   pin cards from the committed Oracle fixture, a committed
 *                                           fixture file that holds one Oracle object for the name,
 *                                           or the Scryfall bulk file when it is present
 *   bun run pin-store seed                  pin every manifest card from the fixture files that
 *                                           already hold its exact Oracle object
 *
 * Adding a name that the store already pins to a different Oracle object moves the name to the
 * new pin and keeps the old one, so tests that name a hash keep working.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '../packages/shared/src';
import {
  PIN_STORE_PATH,
  oracleHashes,
  oracleSha256,
  pinStoreErrors,
  type PinStoreFile,
} from '../packages/engine/tests/scenario/pin-store';
import { toOracleCard, type RawScryfallCard } from '../packages/server/src/cards/scryfall';

const COVERAGE_ORACLE = 'packages/server/fixtures/coverage-oracle.json';
const BULK = 'data/scryfall-oracle-cards.json';
const MANIFEST = 'packages/server/fixtures/card-verification-manifest.json';
const FIXTURE_DIRS = ['packages/engine/tests/fixtures', 'packages/server/fixtures'];

function readStore(): PinStoreFile {
  if (!existsSync(PIN_STORE_PATH)) return { schemaVersion: 1, names: {}, cards: {} };
  return JSON.parse(readFileSync(PIN_STORE_PATH, 'utf8')) as PinStoreFile;
}

/** Keys sorted, so a pin changes one region of the file. */
function writeStore(file: PinStoreFile): void {
  const sorted = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  const errors = pinStoreErrors(file);
  if (errors.length > 0)
    throw new Error(`refusing to write an inconsistent store:\n${errors.join('\n')}`);
  writeFileSync(
    PIN_STORE_PATH,
    `${JSON.stringify({ schemaVersion: 1, names: sorted(file.names), cards: sorted(file.cards) }, null, 2)}\n`,
  );
}

function pin(file: PinStoreFile, card: OracleCard, sha = oracleSha256(card)): string {
  file.cards[sha] = card;
  file.names[card.name] = sha;
  return sha;
}

/** Every Oracle object a committed fixture holds: pinned entries, bare lists, and the pool. */
function fixtureCards(): Map<string, OracleCard> {
  const cards = new Map<string, OracleCard>();
  for (const dir of FIXTURE_DIRS) {
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { cards?: unknown }).cards)
          ? (parsed as { cards: unknown[] }).cards
          : [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        const card = ('card' in entry ? (entry as { card: unknown }).card : entry) as OracleCard;
        if (typeof card.name !== 'string' || typeof card.oracleText !== 'string') continue;
        for (const sha of oracleHashes(card)) cards.set(sha, card);
      }
    }
  }
  return cards;
}

function seed(): void {
  const file = readStore();
  const available = fixtureCards();
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    cards: Record<string, { name: string; oracleSha256: string }>;
  };
  const missing: string[] = [];
  for (const entry of Object.values(manifest.cards)) {
    const card = available.get(entry.oracleSha256);
    if (card === undefined) missing.push(entry.name);
    else pin(file, card, entry.oracleSha256);
  }
  writeStore(file);
  console.log(
    `pinned ${Object.keys(file.names).length} names, ${Object.keys(file.cards).length} cards`,
  );
  if (missing.length > 0)
    console.log(`no fixture holds the manifest's pin of: ${missing.join(', ')}`);
}

function add(names: string[]): void {
  const file = readStore();
  const pool = JSON.parse(readFileSync(COVERAGE_ORACLE, 'utf8')) as OracleCard[];
  let bulk: RawScryfallCard[] | null = null;
  let fixtures: OracleCard[] | undefined;
  for (const name of names) {
    let card = pool.find((candidate) => candidate.name === name) ?? null;
    // A card pinned in a committed engine or server fixture file (one batch's Oracle fixture).
    if (card === null) {
      fixtures ??= [...new Set(fixtureCards().values())];
      const matches = fixtures.filter((candidate) => candidate.name === name);
      const distinct = new Set(matches.map((candidate) => oracleSha256(candidate)));
      if (distinct.size === 1) card = matches[0]!;
      else if (distinct.size > 1) {
        console.error(`"${name}" has ${distinct.size} different Oracle objects in fixture files`);
        process.exitCode = 1;
        continue;
      }
    }
    if (card === null) {
      if (bulk === null && existsSync(BULK))
        bulk = JSON.parse(readFileSync(BULK, 'utf8')) as RawScryfallCard[];
      const raw = bulk?.find((candidate) => candidate.name === name);
      card = raw === undefined ? null : toOracleCard(raw);
    }
    if (card === null) {
      console.error(
        `"${name}" is in neither ${COVERAGE_ORACLE} nor ${existsSync(BULK) ? BULK : `${BULK} (missing)`}`,
      );
      process.exitCode = 1;
      continue;
    }
    const before = file.names[name];
    const sha = pin(file, card);
    console.log(
      before === undefined
        ? `pinned ${name} ${sha}`
        : before === sha
          ? `${name} unchanged`
          : `${name} moved ${before} -> ${sha}`,
    );
  }
  writeStore(file);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'seed') seed();
else if (command === 'add' && rest.length > 0) add(rest);
else {
  console.error('usage: bun run pin-store add "<name>" [...] | bun run pin-store seed');
  process.exit(2);
}
