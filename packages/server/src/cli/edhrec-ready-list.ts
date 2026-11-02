/**
 * List the EDHREC-ranked cards that are modeled or one rules line away from it.
 *
 *   bun run edhrec:ready-list                 # Oracle text from data/scryfall-oracle-cards.json
 *   bun run edhrec:ready-list --bank <file>   # another Scryfall bank
 *   bun run edhrec:ready-list --check         # fail if the committed list is out of date
 *
 * Reads the frozen ranking in `packages/server/fixtures/edhrec-ranking.json` and writes
 * `docs/plans/edhrec-ready-list.md`. Needs the gitignored Scryfall bank: the ranking spans about
 * 13,000 cards, far more than the pinned Oracle fixture. Never uses the network.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadOracleIndexFromFile } from '../cards/oracle-index';
import { measureCoverage } from '../cards/coverage';
import {
  readiness,
  renderReadyList,
  type EdhrecRanking,
  type ReadyListEntry,
} from '../cards/edhrec-ranking';

const RANKING_PATH = 'packages/server/fixtures/edhrec-ranking.json';
const OUTPUT_PATH = 'docs/plans/edhrec-ready-list.md';
const DEFAULT_BANK = 'data/scryfall-oracle-cards.json';

function option(name: string): string | undefined {
  const slot = process.argv.indexOf(name);
  if (slot < 0) return undefined;
  const value = process.argv[slot + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function main(): void {
  const bank = option('--bank') ?? DEFAULT_BANK;
  const ranking = JSON.parse(readFileSync(resolve(RANKING_PATH), 'utf8')) as EdhrecRanking;
  console.error(`Loading Oracle data from ${bank} …`);
  const index = loadOracleIndexFromFile(resolve(bank));

  const unresolved: string[] = [];
  const entries: ReadyListEntry[] = [];
  let otherCards = 0;
  let otherDecks = 0;
  ranking.cards.forEach(([name, decks, kind], position) => {
    const card = index.resolve(name);
    if (card === null) {
      unresolved.push(name);
      return;
    }
    const coverage = measureCoverage([{ name: 'EDHREC', cards: [card] }]).cards[0]!;
    const ready = readiness(coverage);
    if (ready === null) {
      otherCards += 1;
      otherDecks += decks;
      return;
    }
    entries.push({ rank: position + 1, name, decks, kind, readiness: ready });
  });
  if (unresolved.length > 0) {
    console.error(`edhrec:ready-list: ${bank} has no Oracle card for: ${unresolved.join(', ')}`);
    process.exit(2);
  }

  const markdown = renderReadyList({
    ranking,
    oracleSource: `\`${bank}\``,
    entries,
    otherCards,
    otherDecks,
  });

  if (process.argv.includes('--check')) {
    const current = readFileSync(resolve(OUTPUT_PATH), 'utf8');
    if (current !== markdown) {
      console.error(`${OUTPUT_PATH} is out of date; run bun run edhrec:ready-list`);
      process.exit(1);
    }
    console.log(`${OUTPUT_PATH} is up to date.`);
    return;
  }
  writeFileSync(resolve(OUTPUT_PATH), markdown);
  const count = (status: string): number =>
    entries.filter((entry) => entry.readiness.status === status).length;
  console.log(
    `Wrote ${OUTPUT_PATH}: ${count('modeled')} modeled, ${count('one-line')} one line away, ${otherCards} neither, of ${ranking.cards.length}.`,
  );
}

main();
