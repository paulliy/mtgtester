/**
 * `bun run mutate-cards` (ADR 0034 decision 5): for each card, apply every IR mutant to its final
 * definition one at a time and run the card's manifest tests once per mutant, through
 * `vitest.mutation.config.ts`. A mutant is killed only by a failed assertion; one the hook never
 * applied is unreached; a survivor fails unless the manifest records it in `equivalentMutants`.
 *
 *   --card "<name>"       a card (repeatable)
 *   --changed [--base S]  reviewed cards whose definition snapshot entry changed against S (the
 *                         pull request's base; default MUTATION_BASE, then HEAD's first parent);
 *                         changed unreviewed cards run as a report
 *   --reviewed            every implemented-reviewed card, as a report
 *   --collected <json>    reuse a `vitest list --json` listing
 *   --json <path>         write every verdict
 *
 * It exits 1 when a reviewed card it was asked to check has a surviving or unreached mutant, or
 * tests that fail without one; `--reviewed` reports and exits 0.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createVitest } from 'vitest/node';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { cardMutants } from '../packages/engine/tests/mutation/operators';
import type { MutationTarget } from '../packages/engine/tests/mutation/setup';
import { pinStore } from '../packages/engine/tests/scenario/pin-store';
import { snapshotChanges } from './cards/card-finish';
import { indexTests, type CollectedTest } from './contracts/manifest-tests';
import {
  cardStatuses,
  cardTests,
  equivalentMutants,
  judgeMutant,
  testNamePattern,
  type MutantTestResult,
  type MutantVerdict,
} from './contracts/mutation';

const MANIFEST = 'packages/server/fixtures/card-verification-manifest.json';
const SNAPSHOTS = [
  'packages/engine/tests/fixtures/interpret-defs.json',
  'packages/engine/tests/fixtures/override-defs.json',
];
const args = process.argv.slice(2);
const option = (flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? null : (args[at + 1] ?? null);
};
const root = `${process.cwd().replaceAll('\\', '/')}/`;
const manifestJson = readFileSync(MANIFEST, 'utf8');
const statuses = cardStatuses(manifestJson);
const git = (...gitArgs: string[]) =>
  execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 1 << 28 });

function changedCards(): string[] {
  const candidate = option('--base') ?? process.env['MUTATION_BASE'] ?? '';
  const base = /^[0-9a-f]{7,40}$/.test(candidate.trim())
    ? candidate.trim()
    : git('rev-parse', 'HEAD^').trim();
  const names = new Set<string>();
  for (const path of SNAPSHOTS) {
    let before = '[]';
    try {
      before = git('show', `${base}:${path}`);
    } catch {
      // A snapshot the base does not have: every entry is new.
    }
    for (const change of snapshotChanges(before, readFileSync(path, 'utf8')))
      if (change.kind !== 'removed') names.add(change.name);
  }
  return [...names].filter((name) => statuses.has(name)).sort();
}

function collect(): CollectedTest[] {
  let path = option('--collected');
  const scratch = path === null ? mkdtempSync(join(tmpdir(), 'mutate-cards-')) : null;
  try {
    if (path === null) {
      path = join(scratch!, 'tests.json');
      execFileSync('bunx', ['vitest', 'list', `--json=${path}`], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
    }
    return (JSON.parse(readFileSync(path, 'utf8')) as Array<{ name: string; file: string }>).map(
      (entry) => ({
        file: entry.file.replaceAll('\\', '/').replace(root, ''),
        fullName: entry.name,
      }),
    );
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}

const reportOnly = args.includes('--reviewed');
const cards = reportOnly
  ? [...statuses].filter(([, status]) => status === 'implemented-reviewed').map(([name]) => name)
  : args.includes('--changed')
    ? changedCards()
    : args.flatMap((arg, at) => (args[at - 1] === '--card' ? [arg] : []));
if (cards.length === 0) {
  console.log('mutate-cards: no cards to mutate');
  process.exit(0);
}

const index = indexTests(collect());
const read = (path: string) => readFileSync(path, 'utf8');
const vitest = await createVitest(
  'test',
  { config: 'vitest.mutation.config.ts', watch: false, reporters: [{}] },
  {},
);

interface CardReport {
  card: string;
  status: string;
  tests: number;
  mutants: Array<{ label: string } & MutantVerdict>;
  /** Tests that fail with no mutant installed: no verdict can be trusted. */
  baselineFailures: string[];
  seconds: number;
}

async function run(
  tests: readonly CollectedTest[],
  target: MutationTarget | null,
): Promise<MutantTestResult[]> {
  vitest.provide('mutation', target);
  vitest.setGlobalTestNamePattern(testNamePattern(tests));
  const files = [...new Set(tests.map((test) => resolve(test.file)))];
  const specifications = await vitest.getRelevantTestSpecifications(files);
  const result = await vitest.rerunTestSpecifications(specifications);
  const wanted = new Set(tests.map((test) => `${resolve(test.file)}\0${test.fullName}`));
  const results: MutantTestResult[] = [];
  for (const module of result.testModules)
    for (const test of module.children.allTests()) {
      if (!wanted.has(`${module.moduleId}\0${test.fullName}`)) continue;
      const outcome = test.result();
      results.push({
        fullName: test.fullName,
        state: outcome.state,
        errorNames:
          outcome.state === 'failed' ? outcome.errors.map((error) => error.name ?? 'Error') : [],
        applied: test.meta().mutationApplied ?? 0,
      });
    }
  return results;
}

const reports: CardReport[] = [];
for (const card of cards) {
  const started = Date.now();
  const status = statuses.get(card)!;
  const tests = cardTests(manifestJson, card, index, read);
  const mutants = cardMutants(interpretCard(pinStore.get(card)));
  const report: CardReport = {
    card,
    status,
    tests: tests.length,
    mutants: [],
    baselineFailures: [],
    seconds: 0,
  };
  reports.push(report);
  if (tests.length === 0) {
    console.log(`${card}: no manifest test resolves to one collected test`);
    continue;
  }
  const baseline = await run(tests, null);
  report.baselineFailures = baseline
    .filter((test) => test.state !== 'passed')
    .map((test) => test.fullName);
  if (baseline.length < tests.length) report.baselineFailures.push('(some tests did not run)');
  if (report.baselineFailures.length > 0) {
    console.log(`${card}: ${report.baselineFailures.length} test(s) fail with no mutant`);
    continue;
  }
  const equivalent = new Set(equivalentMutants(manifestJson, card).map(({ mutant }) => mutant));
  for (const [at, mutant] of mutants.entries()) {
    const verdict = judgeMutant(await run(tests, { card, index: at, label: mutant.label }));
    if (verdict.status === 'survived' && equivalent.has(mutant.label))
      verdict.status = 'equivalent';
    report.mutants.push({ label: mutant.label, ...verdict });
  }
  report.seconds = Math.round((Date.now() - started) / 100) / 10;
  const count = (wanted: string) =>
    report.mutants.filter((mutant) => mutant.status === wanted).length;
  console.log(
    `${card} (${status}): ${tests.length} tests, ${mutants.length} mutants: ${count('killed')} killed, ${count('survived')} survived, ${count('unreached')} unreached, ${count('equivalent')} equivalent (${report.seconds}s)`,
  );
  for (const mutant of report.mutants)
    if (mutant.status === 'survived' || mutant.status === 'unreached')
      console.log(`  ${mutant.status}: ${mutant.label}`);
}
await vitest.close();

const jsonPath = option('--json');
if (jsonPath !== null) writeFileSync(jsonPath, `${JSON.stringify(reports, null, 2)}\n`);
const failing = reports.filter(
  (report) =>
    report.status === 'implemented-reviewed' &&
    (report.baselineFailures.length > 0 ||
      report.mutants.some(
        (mutant) => mutant.status === 'survived' || mutant.status === 'unreached',
      )),
);
console.log(
  `mutate-cards: ${reports.length} card(s), ${reports.reduce((sum, report) => sum + report.mutants.length, 0)} mutants; ${failing.length} reviewed card(s) not proven`,
);
process.exit(failing.length > 0 && !reportOnly ? 1 : 0);
