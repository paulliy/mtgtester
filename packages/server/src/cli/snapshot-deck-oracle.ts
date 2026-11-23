/**
 * Snapshot a deck's resolved `OracleCard`s into a JSON fixture the ENGINE tests can read.
 *
 *   bun run snapshot:oracle <deckFixture.txt> <outFile.json>
 *
 * Why this exists: `bun run coverage` is the human-facing instrument, but it loads the
 * gitignored 180 MB Scryfall bulk (`packages/server/src/cli/coverage.ts:19`), so it cannot run
 * in CI and is not a test. Per-deck closure work needs a check that runs in `bun run test` on a
 * clean checkout — hence a small committed projection of just that deck's cards.
 *
 * The fixture is the exact `OracleCard` shape `interpretCard` consumes, so the engine test
 * measures the same thing the CLI does, offline.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { loadOracleIndexFromFile } from '../cards/oracle-index-file';
import { importDeck } from '../decks/source';
import { resolveDeck } from '../decks/resolve';

const BULK_PATH = 'data/scryfall-oracle-cards.json';

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (input === undefined || output === undefined) {
    console.error('usage: bun run snapshot:oracle <deckFixture.txt> <out.json>');
    process.exit(2);
  }

  console.error(`Loading oracle data from ${BULK_PATH} …`);
  const index = loadOracleIndexFromFile(resolve(BULK_PATH));

  const parsed = await importDeck(readFileSync(resolve(input), 'utf8'));
  const { resolved, unresolvedNames } = resolveDeck(parsed, index);
  if (resolved === null) {
    console.error(`✗ unresolved names: ${unresolvedNames.join(', ')}`);
    process.exit(1);
  }

  // Commanders and the companion live OUTSIDE `.cards` — unioning them is not optional, or the
  // commander (the most mechanically complex card in the deck) goes unmeasured.
  const all: OracleCard[] = [
    ...resolved.commanders,
    ...(resolved.companion === null ? [] : [resolved.companion]),
    ...resolved.cards.map((e) => e.card),
  ];

  // De-duplicate by oracle id and sort by name, so the fixture is a stable diff.
  const unique = [...new Map(all.map((c) => [c.oracleId, c])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), `${JSON.stringify(unique, null, 2)}\n`, 'utf8');
  console.error(`✓ ${output} — ${unique.length} unique cards`);
}

void main();
