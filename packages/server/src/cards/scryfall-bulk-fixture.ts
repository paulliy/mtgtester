/**
 * Test-only helper: load the Scryfall bulk file (`data/README.md`) for suites that test against
 * real printed cards, from disk at runtime rather than a static `assert { type: 'json' }` import.
 *
 * The file is gitignored (~180 MB) and the repo has no CI pipeline provisioning it, so a static
 * import of it turns a fresh clone or any CI run into a hard "can't find module" failure for
 * every suite that names it — indistinguishable from a real bug, and not scoped to just the
 * suites that need it. Loading it lazily behind `existsSync` lets a suite `describe.skipIf` a
 * clean, reported skip instead.
 *
 * Production code (`oracle-index.ts::loadOracleIndexFromFile`) deliberately still THROWS on a
 * missing file — a human running `bun run decks` should see an actionable error, not a silent
 * no-op. Tests are the opposite case: nothing is present to react to a crash, so skipping is the
 * only outcome that doesn't misreport an infra gap as a code regression.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RawScryfallCard } from './scryfall';

const DEFAULT_PATH = fileURLToPath(
  new URL('../../../../data/scryfall-oracle-cards.json', import.meta.url),
);

// undefined = not yet attempted; null = confirmed missing. Cached so five suites sharing this
// helper parse the 180 MB file once between them, not once each.
let cache: RawScryfallCard[] | null | undefined;

/** The parsed bulk file, or `null` if it is not present on disk at `path`. */
export function loadScryfallBulkOrNull(path: string = DEFAULT_PATH): RawScryfallCard[] | null {
  if (cache !== undefined) return cache;
  if (!existsSync(path)) {
    console.warn(
      `[scryfall-bulk-fixture] ${path} not found — skipping suites that need it (see data/README.md).`,
    );
    cache = null;
    return null;
  }
  cache = JSON.parse(readFileSync(path, 'utf8')) as RawScryfallCard[];
  return cache;
}
