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
 *   --json <path>         write every verdict, after each card
 *   --resume              with --json, skip the cards that file already reports
 *
 * Each card runs in a child process (`--child`) that prints one line per run. A mutant can make a
 * test worker die (a heap blown by an option-enumeration explosion), which ends the child; the
 * parent records that mutant's run as a crash, not a kill, and resumes from the next mutant.
 *
 * It exits 1 when a reviewed card it was asked to check has a surviving or unreached mutant, or
 * tests that fail without one; `--reviewed` reports and exits 0.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createVitest } from 'vitest/node';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { cardMutants } from '../packages/engine/tests/mutation/operators';
import type { MutationTarget } from '../packages/engine/tests/mutation/setup';
import { pinStore } from '../packages/engine/tests/scenario/pin-store';
import { snapshotChanges } from './cards/card-finish';
import { cardNames, indexTests, type CollectedTest } from './contracts/manifest-tests';
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
  // A face's entry ("Web Shot") is its card's ("Ettercap // Web Shot").
  const cardOf = new Map<string, string>();
  for (const name of statuses.keys())
    for (const face of cardNames(name)) if (!cardOf.has(face)) cardOf.set(face, name);
  return [...new Set([...names].flatMap((name) => cardOf.get(name) ?? []))].sort();
}

/** The Vitest listing's path: `--collected`, or a fresh `vitest list` in `scratch`. */
function listing(scratch: string): string {
  const given = option('--collected');
  if (given !== null) return given;
  const path = join(scratch, 'tests.json');
  execFileSync('bunx', ['vitest', 'list', `--json=${path}`], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return path;
}

function readListing(path: string): CollectedTest[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as Array<{ name: string; file: string }>).map(
    (entry) => ({ file: entry.file.replaceAll('\\', '/').replace(root, ''), fullName: entry.name }),
  );
}

// ── Child: one card, from one mutant on ─────────────────────────────────────────────────────────

/** Runs the card's tests: with no mutant (`--from -1` first) and then each mutant from `--from`. */
async function child(card: string): Promise<void> {
  const tests = cardTests(
    manifestJson,
    card,
    indexTests(readListing(option('--collected')!)),
    (path) => readFileSync(path, 'utf8'),
  );
  const mutants = cardMutants(interpretCard(pinStore.get(card)));
  console.log(`TESTS ${tests.length} ${mutants.length}`);
  if (tests.length === 0) return;
  const vitest = await createVitest(
    'test',
    { config: 'vitest.mutation.config.ts', watch: false, reporters: [{}] },
    {},
  );
  const run = async (target: MutationTarget | null): Promise<MutantTestResult[]> => {
    vitest.provide('mutation', target);
    vitest.setGlobalTestNamePattern(testNamePattern(tests));
    const files = [...new Set(tests.map((test) => resolve(test.file)))];
    const result = await vitest.rerunTestSpecifications(
      await vitest.getRelevantTestSpecifications(files),
    );
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
  };
  const from = Number(option('--from') ?? '-1');
  if (from === -1) {
    const baseline = await run(null);
    const failures = baseline
      .filter((test) => test.state !== 'passed')
      .map((test) => test.fullName);
    if (baseline.length < tests.length) failures.push('(some tests did not run)');
    console.log(`BASELINE ${JSON.stringify(failures)}`);
    if (failures.length > 0) return void (await vitest.close());
  }
  for (let at = Math.max(from, 0); at < mutants.length; at++)
    console.log(
      `MUTANT ${at} ${JSON.stringify(await run({ card, index: at, label: mutants[at]!.label }))}`,
    );
  await vitest.close();
}

const childCard = option('--child');
if (childCard !== null) {
  await child(childCard);
  process.exit(0);
}

// ── Parent: the cards, a child each ─────────────────────────────────────────────────────────────

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

interface CardReport {
  card: string;
  status: string;
  tests: number;
  mutants: Array<{ label: string } & MutantVerdict>;
  /** Tests that fail with no mutant installed: no verdict can be trusted. */
  baselineFailures: string[];
  seconds: number;
}

/** One child run's lines, from `--from` on, and whether it finished. */
function runChild(card: string, collected: string, from: number) {
  const child = spawnSync(
    process.execPath,
    [process.argv[1]!, '--child', card, '--collected', collected, '--from', String(from)],
    { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const lines = child.stdout.split('\n');
  const field = (prefix: string) => lines.filter((line) => line.startsWith(prefix));
  return {
    finished: child.status === 0,
    counts: field('TESTS ')[0]?.split(' ').slice(1).map(Number),
    baseline: field('BASELINE ').map((line) => JSON.parse(line.slice(9)) as string[])[0],
    mutants: field('MUTANT ').map((line) => {
      const [, at, json] = /^MUTANT (\d+) (.*)$/s.exec(line)!;
      return { at: Number(at), results: JSON.parse(json!) as MutantTestResult[] };
    }),
  };
}

const crashedRun = (reason: string): MutantVerdict => ({
  status: 'survived',
  killedBy: [],
  crashed: [`(the run ended: ${reason})`],
});

const jsonPath = option('--json');
// `--resume` keeps the cards an earlier run with the same `--json` path already reported.
const reports: CardReport[] =
  jsonPath !== null && args.includes('--resume') && existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as CardReport[])
    : [];
const done = new Set(reports.map((report) => report.card));
const scratch = mkdtempSync(join(tmpdir(), 'mutate-cards-'));
try {
  const collected = listing(scratch);
  for (const card of cards.filter((name) => !done.has(name))) {
    const started = Date.now();
    const status = statuses.get(card)!;
    const mutants = cardMutants(interpretCard(pinStore.get(card)));
    const report: CardReport = {
      card,
      status,
      tests: 0,
      mutants: [],
      baselineFailures: [],
      seconds: 0,
    };
    reports.push(report);
    const equivalent = new Set(equivalentMutants(manifestJson, card).map(({ mutant }) => mutant));
    let from = -1;
    while (from < mutants.length) {
      const run = runChild(card, collected, from);
      report.tests = run.counts?.[0] ?? report.tests;
      if (from === -1) {
        if (report.tests === 0 && run.finished) break;
        report.baselineFailures = run.baseline ?? ['(the run ended before the baseline finished)'];
        if (report.baselineFailures.length > 0) break;
      }
      for (const { at, results } of run.mutants) {
        const verdict = judgeMutant(results);
        if (verdict.status === 'survived' && equivalent.has(mutants[at]!.label))
          verdict.status = 'equivalent';
        report.mutants.push({ label: mutants[at]!.label, ...verdict });
      }
      if (run.finished) break;
      // The child died on the mutant after the last one it reported.
      const crashed = report.mutants.length;
      if (crashed >= mutants.length) break;
      report.mutants.push({
        label: mutants[crashed]!.label,
        ...crashedRun('a test worker or the runner died'),
      });
      from = crashed + 1;
    }
    report.seconds = Math.round((Date.now() - started) / 100) / 10;
    if (report.tests === 0) console.log(`${card}: no manifest test resolves to one collected test`);
    else if (report.baselineFailures.length > 0)
      console.log(`${card}: ${report.baselineFailures.length} test(s) fail with no mutant`);
    else {
      const count = (wanted: string) =>
        report.mutants.filter((mutant) => mutant.status === wanted).length;
      console.log(
        `${card} (${status}): ${report.tests} tests, ${mutants.length} mutants: ${count('killed')} killed, ${count('survived')} survived, ${count('unreached')} unreached, ${count('equivalent')} equivalent (${report.seconds}s)`,
      );
      for (const mutant of report.mutants)
        if (mutant.status === 'survived' || mutant.status === 'unreached')
          console.log(
            `  ${mutant.status}: ${mutant.label}${mutant.crashed[0]?.startsWith('(the run ended') ? ' (run ended)' : ''}`,
          );
    }
    if (jsonPath !== null) writeFileSync(jsonPath, `${JSON.stringify(reports, null, 2)}\n`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

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
