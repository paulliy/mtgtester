/**
 * Build the table server's prebuilt card file from the Scryfall bulk file.
 *
 *   bun run table:cards                    # data/scryfall-oracle-cards.json -> data/table-oracle-cards.json
 *   bun run table:cards --from <bulk.json> --out <file>
 *
 * Run it after `bun run scryfall:update`. `serve:table` then reads the small file instead of the
 * ~200 MB bulk file (`cards/table-cards.ts`). The bulk file can be deleted afterwards on a server
 * that only hosts tables.
 */

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RawScryfallCard } from '../cards/scryfall';
import { convertBulkCards, serializeTableCards, TABLE_CARDS_PATH } from '../cards/table-cards';

const BULK_PATH = 'data/scryfall-oracle-cards.json';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a file path.`);
    process.exit(1);
  }
  return value;
}

function main(): void {
  const from = resolve(argument('--from', BULK_PATH));
  const out = resolve(argument('--out', TABLE_CARDS_PATH));

  let bytes: Buffer;
  try {
    bytes = readFileSync(from);
  } catch {
    console.error(
      `\nNo bulk file at ${from}. Run \`bun run scryfall:update\` first (data/README.md).\n`,
    );
    process.exit(1);
  }
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(parsed)) {
    console.error(`\nExpected a JSON array of cards in ${from}.\n`);
    process.exit(1);
  }
  const cards = convertBulkCards(parsed as RawScryfallCard[]);

  const temporary = `${out}.tmp`;
  writeFileSync(temporary, serializeTableCards(cards, sourceSha256));
  renameSync(temporary, out);

  const mb = (path: string): string => (statSync(path).size / 1_000_000).toFixed(1);
  console.log(`Read ${parsed.length.toLocaleString()} bulk entries (${mb(from)} MB) from ${from}`);
  console.log(`Wrote ${cards.length.toLocaleString()} cards (${mb(out)} MB) to ${out}`);
}

main();
