/**
 * Build the website's card data (`cards/site-cards.ts`, ADR 0053) into a folder of static files.
 *
 *   bun run site:cards                              # data/table-oracle-cards.json -> data/site-cards/
 *   bun run site:cards --from <table-cards file> --out <folder>
 *   bun run site:cards --oracle-fixture <cards.json> --out <folder>
 *
 * Run it after `bun run table:cards`. The folder is replaced whole, so it never holds files from
 * an older build; the site serves it as-is, with `manifest.json` uncached and the rest immutable.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ENGINE_VERSION } from '@mtg/engine';
import type { OracleCard } from '@mtg/shared';
import { readBuildInfo } from '../build-info';
import { listKnownDecks } from '../cards/known-decks';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { buildSiteCards } from '../cards/site-cards';
import { loadTableCards, TABLE_CARDS_PATH } from '../cards/table-cards';
import { loadBannedList } from '../decks/banned-file';

const BANNED_PATH = 'docs/rules/commander-banned-list.md';
const OUT_PATH = 'data/site-cards';

function argument(name: string): string | null {
  const at = process.argv.indexOf(name);
  if (at === -1) return null;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a path.`);
    process.exit(1);
  }
  return value;
}

function readCards(): { cards: OracleCard[]; sourceSha256: string; from: string } {
  const fixture = argument('--oracle-fixture');
  if (fixture !== null) {
    const bytes = readFileSync(resolve(fixture));
    return {
      cards: JSON.parse(bytes.toString('utf8')) as OracleCard[],
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      from: resolve(fixture),
    };
  }
  const from = resolve(argument('--from') ?? TABLE_CARDS_PATH);
  try {
    const { cards, sourceSha256 } = loadTableCards(from);
    return { cards, sourceSha256, from };
  } catch (error) {
    console.error(`\n${(error as Error).message}\nRun \`bun run table:cards\` first.\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const out = resolve(argument('--out') ?? OUT_PATH);
  const { cards, sourceSha256, from } = readCards();
  const banned = loadBannedList(resolve(BANNED_PATH));
  const decks = await listKnownDecks(buildOracleIndexFromCards(cards), banned);

  const { manifest, files } = buildSiteCards({
    cards,
    bannedNames: banned.names,
    decks,
    sourceSha256,
    engine: { version: ENGINE_VERSION, commit: readBuildInfo(process.cwd()).commit },
  });

  const temporary = `${out}.tmp`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(temporary, name), text);
  rmSync(out, { recursive: true, force: true });
  renameSync(temporary, out);

  let bytes = 0;
  for (const name of files.keys()) bytes += statSync(join(out, name)).size;
  console.log(`Read ${cards.length.toLocaleString()} cards from ${from}`);
  console.log(
    `Wrote ${files.size} files (${(bytes / 1_000_000).toFixed(1)} MB) to ${out}: ` +
      `${manifest.counts.pool.toLocaleString()} pool cards of ${manifest.counts.considered.toLocaleString()} ` +
      `Commander-legal, ${manifest.counts.decks} bot decks, ${manifest.counts.banned} banned names.`,
  );
  console.log(
    `Content ${manifest.contentSha256.slice(0, 16)}, engine commit ${manifest.engine.commit ?? 'unknown'}`,
  );
}

await main();
