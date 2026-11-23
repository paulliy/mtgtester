/**
 * The table server's prebuilt card file: every card of the Scryfall bulk file, already converted
 * to engine form (`OracleCard`), with a small header.
 *
 * `serve:table` used to parse the whole ~200 MB bulk file at every start, holding the raw text,
 * the raw Scryfall objects (prices, image URIs, every format's legality, ...) and the converted
 * cards at once. The converted cards are all it keeps, and all a table game can reach, so
 * `bun run table:cards` writes them once and the server reads only them (tens of megabytes).
 *
 * Converting here and converting at startup give the same cards: both run `toOracleCard` over the
 * same bulk file, and the server builds its name index and supported pool from the result exactly
 * as it does for `--oracle-fixture`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { toOracleCard, type RawScryfallCard } from './scryfall';

/** Changes whenever the file's shape does; a reader refuses any other value. */
export const TABLE_CARDS_FORMAT = 'mtg-table-cards/1';

/** Where `bun run table:cards` writes and `serve:table` looks, relative to the repository root. */
export const TABLE_CARDS_PATH = 'data/table-oracle-cards.json';

export interface TableCardsFile {
  format: typeof TABLE_CARDS_FORMAT;
  /** SHA-256 of the bulk file the cards were converted from. */
  sourceSha256: string;
  cards: OracleCard[];
}

/** Convert parsed bulk cards, dropping the ones `toOracleCard` drops (tokens, art cards, ...). */
export function convertBulkCards(raw: readonly RawScryfallCard[]): OracleCard[] {
  const cards: OracleCard[] = [];
  for (const entry of raw) {
    const card = toOracleCard(entry);
    if (card !== null) cards.push(card);
  }
  return cards;
}

/** The file's text for converted cards; one card per line keeps diffs and `head` readable. */
export function serializeTableCards(cards: readonly OracleCard[], sourceSha256: string): string {
  const header = JSON.stringify({ format: TABLE_CARDS_FORMAT, sourceSha256 });
  const body = cards.map((card) => JSON.stringify(card)).join(',\n');
  return `${header.slice(0, -1)},"cards":[\n${body}\n]}\n`;
}

export interface LoadedTableCards {
  cards: OracleCard[];
  sourceSha256: string;
  /** SHA-256 of the prebuilt file itself: the card data a game read, for replay pinning. */
  sha256: string;
}

/** Read and check a prebuilt card file. Throws with an actionable message on any problem. */
export function loadTableCards(path: string): LoadedTableCards {
  const bytes = readFileSync(path);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  const file = parsed as Partial<TableCardsFile> | null;
  if (file === null || typeof file !== 'object' || file.format !== TABLE_CARDS_FORMAT) {
    throw new Error(
      `"${path}" is not a ${TABLE_CARDS_FORMAT} card file. Rebuild it with \`bun run table:cards\`.`,
    );
  }
  if (typeof file.sourceSha256 !== 'string' || !Array.isArray(file.cards)) {
    throw new Error(`"${path}" is damaged. Rebuild it with \`bun run table:cards\`.`);
  }
  return {
    cards: file.cards,
    sourceSha256: file.sourceSha256,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
