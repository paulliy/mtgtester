/**
 * Interpret and validate the whole Scryfall population (ADR 0034 decision 9), for the nightly bulk
 * job.
 *
 *   bun run bulk-smoke [--bank data/scryfall-oracle-cards.json] [--write]
 *
 * Fails on a card whose interpretation throws, a modeled card whose IR does not validate, or fewer
 * modeled cards than the baseline recorded for this bank: `packages/server/fixtures/
 * bulk-population.json`, keyed by the bank's SHA-256, so a new pinned download needs a new
 * baseline. `--write` records the counts as the baseline.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { OracleCard } from '../packages/shared/src';
import { toOracleCard, type RawScryfallCard } from '../packages/server/src/cards/scryfall';
import { populationProblems, populationSmoke } from './contracts/population-smoke';

const BASELINE = 'packages/server/fixtures/bulk-population.json';

interface Baseline {
  bankSha256: string;
  cards: number;
  modeled: number;
}

const argv = process.argv.slice(2);
const bankAt = argv.indexOf('--bank');
const bank = bankAt >= 0 ? argv[bankAt + 1]! : 'data/scryfall-oracle-cards.json';
const write = argv.includes('--write');

const bytes = readFileSync(bank);
const bankSha256 = createHash('sha256').update(bytes).digest('hex');
const cards = (JSON.parse(bytes.toString('utf8')) as RawScryfallCard[]).flatMap((raw) => {
  const card = toOracleCard(raw);
  return card === null ? [] : [card as OracleCard];
});
const smoke = populationSmoke(cards);
console.log(
  `bulk-smoke: ${smoke.cards} cards, ${smoke.modeled} modeled, ${smoke.threw.length} threw, ${smoke.invalid.length} invalid (bank ${bankSha256.slice(0, 12)})`,
);

if (write) {
  const baseline: Baseline = { bankSha256, cards: smoke.cards, modeled: smoke.modeled };
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`bulk-smoke: recorded the baseline in ${BASELINE}`);
}
const recorded = existsSync(BASELINE)
  ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline)
  : undefined;
const problems = populationProblems(
  smoke,
  recorded?.bankSha256 === bankSha256 ? recorded : undefined,
);
if (recorded?.bankSha256 !== bankSha256)
  problems.push(
    `no baseline for this bank: download the pinned bank, run bun run bulk-smoke --write and commit ${BASELINE}`,
  );
for (const problem of problems) console.log(`  ${problem}`);
if (problems.length > 0) process.exitCode = 1;
