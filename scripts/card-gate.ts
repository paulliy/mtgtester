/**
 * `bun run test:card-gate`'s test run (ADR 0033 decision 1, plan phase 2 step 6): every Vitest
 * test file matching an entry of the committed list `scripts/card-gate.txt`. An entry that
 * matches no file fails before anything runs; the resolved files go to Vitest by path, so the set
 * that runs is exactly the one printed. It first prints facet warnings for the cards whose
 * definitions changed against `CARD_GATE_BASE` (or `RATCHET_BASE`, or HEAD's first parent).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { pinStore } from '../packages/engine/tests/scenario/pin-store';
import { baseCommit, changedCards } from './cards/changed-cards';
import { facetNotes, facetReport } from './cards/facet-report';
import {
  CARD_GATE_LIST,
  cardGateEntries,
  cardGateErrors,
  cardGateFiles,
  discoverRunners,
} from './contracts/suite-integrity';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter((file) => file !== '');
const read = (path: string) => readFileSync(path, 'utf8');
const { runners, errors } = discoverRunners({ files, read });
const entries = cardGateEntries(read(CARD_GATE_LIST));
errors.push(...cardGateErrors(entries, files, runners));
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

// Facet warnings for the cards this change touches (ADR 0034 decision 6): printed, not failed on,
// until a facet finds a real defect outside its fixture.
const manifestJson = read('packages/server/fixtures/card-verification-manifest.json');
const manifestCards = (JSON.parse(manifestJson) as { cards: Record<string, { name: string }> })
  .cards;
// The base only picks which cards get facet warnings, so an unusable one from CI (a force-push's
// `before` SHA is not in the clone) warns and falls back to HEAD's first parent.
const envBase = process.env['CARD_GATE_BASE'] ?? process.env['RATCHET_BASE'];
let base: string;
try {
  base = baseCommit(envBase);
} catch (error) {
  console.log(`::warning::${(error as Error).message}; comparing with HEAD's first parent instead`);
  base = baseCommit(undefined);
}
for (const name of changedCards(
  base,
  Object.values(manifestCards).map((card) => card.name),
)) {
  if (!pinStore.has(name)) continue;
  const card = pinStore.get(name);
  const lines = facetReport(card, interpretCard(card), facetNotes(manifestJson, name));
  if (lines.length > 0)
    console.log(`facets: ${name}\n${lines.map((line) => `  ${line}`).join('\n')}`);
}

const gate = cardGateFiles(entries, files, runners);
console.log(`card gate: ${entries.length} entries, ${gate.length} test files`);
const result = spawnSync('bunx', ['vitest', 'run', ...gate, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
