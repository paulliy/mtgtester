/** Load the oracle index from the Scryfall bulk file on disk (`oracle-index.ts` holds the index). */

import { readFileSync } from 'node:fs';
import { buildOracleIndex, type OracleIndex } from './oracle-index';
import type { RawScryfallCard } from './scryfall';

/**
 * Load and index the Scryfall bulk file. Reads the whole file once (acceptable for a one-time
 * import; games use the cache). Throws a clear error if the file is missing so the operator
 * knows to run the download in `data/README.md`.
 */
export function loadOracleIndexFromFile(path: string): OracleIndex {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Scryfall bulk data not found at "${path}". Download it first — see data/README.md.`,
    );
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array of cards in "${path}", got ${typeof parsed}.`);
  }
  return buildOracleIndex(parsed as RawScryfallCard[]);
}
