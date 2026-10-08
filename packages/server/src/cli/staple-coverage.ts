/**
 * Offline model-coverage check for the committed 200-card EDH staple population.
 *
 *   bun run staples
 *   bun run staples --json
 *   bun run staples --oracle-fixture packages/server/fixtures/coverage-oracle.json
 *
 * The ranking itself is frozen as names only. Card data always comes from the same local,
 * gitignored Scryfall bulk cache used by `bun run coverage`, or an explicitly selected pinned
 * Oracle fixture; this command never uses the network. Both routes enforce the same baseline.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { coverageInput } from './coverage-input';
import { measureCoverage } from '../cards/coverage';
import { checkCoverageBaseline } from '../cards/coverage-baseline';
import { assertCompleteCoverage } from '../cards/coverage-contract';

const FIXTURE_PATH = 'packages/server/fixtures/edh-staples-200.txt';
const EXPECTED_CARDS = 200;

function readNames(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function fail(message: string): never {
  console.error(`staple coverage: ${message}`);
  process.exit(2);
}

function main(): void {
  const input = coverageInput(process.argv.slice(2));
  const json = input.args.includes('--json');
  const fixturePath = resolve(FIXTURE_PATH);
  const names = readNames(fixturePath);

  if (names.length !== EXPECTED_CARDS) {
    fail(`expected ${EXPECTED_CARDS} names in ${FIXTURE_PATH}, found ${names.length}`);
  }

  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  if (duplicates.length > 0) fail(`duplicate names: ${duplicates.join(', ')}`);

  if (!json) console.error(`Loading oracle data from ${input.path} …`);
  const index = input.index;
  const resolved = names.map((name) => ({ name, card: index.resolve(name) }));
  const unresolved = resolved.filter((entry) => entry.card === null).map((entry) => entry.name);
  if (unresolved.length > 0) fail(`unresolved names: ${unresolved.join(', ')}`);

  const report = measureCoverage([
    {
      name: 'EDH staples 200',
      cards: resolved.map((entry) => entry.card!),
    },
  ]);

  checkCoverageBaseline(report, index, 'staples');
  if (process.argv.includes('--complete')) assertCompleteCoverage(report);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const percent = ((report.modeledCards / report.uniqueCards) * 100).toFixed(1);
  console.log(`EDH staples: ${report.modeledCards}/${report.uniqueCards} modeled (${percent}%)`);

  const blocked = report.cards.filter((card) => !card.modeled);
  if (blocked.length > 0) {
    console.log('\nUnmodeled cards');
    for (const card of blocked) {
      console.log(`  ${card.name}: ${card.reasons.join('; ')}`);
    }
  }
}

main();
