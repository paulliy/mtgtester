/**
 * IR mutation, the pure half (ADR 0034 decision 5): which tests prove a card, how a mutant's run
 * is judged, and which recorded equivalences excuse a survivor. `scripts/mutate-cards.ts` runs the
 * mutants; everything here is a function of its inputs so the rules can be shown to fire.
 */
import {
  checkReference,
  manifestReferences,
  type CollectedTest,
  type TestIndex,
} from './manifest-tests';

/** One selected test's outcome in a mutant's run. */
export interface MutantTestResult {
  fullName: string;
  state: 'passed' | 'failed' | 'skipped' | 'pending';
  /** The `name` of each error the test failed with: `AssertionError` for a failed `expect`. */
  errorNames: string[];
  /** Times the mutant was applied in the test's file, up to the end of the test. */
  applied: number;
}

export type MutantStatus = 'killed' | 'survived' | 'unreached' | 'equivalent';

export interface MutantVerdict {
  status: MutantStatus;
  /** The tests that failed on an assertion. */
  killedBy: string[];
  /** The tests that failed some other way: a crash, a timeout, a strict driver. */
  crashed: string[];
}

/**
 * A mutant is killed only when a test fails on an assertion; a crash, a timeout or a strict
 * driver's refusal does not show that an assertion depends on the card. A mutant the hook never
 * applied is unreached: the tests built the card's abilities by hand and cannot prove it.
 */
export function judgeMutant(results: readonly MutantTestResult[]): MutantVerdict {
  const killedBy = results
    .filter((test) => test.state === 'failed' && test.errorNames.includes('AssertionError'))
    .map((test) => test.fullName);
  const crashed = results
    .filter((test) => test.state === 'failed' && !test.errorNames.includes('AssertionError'))
    .map((test) => test.fullName);
  const reached = results.some((test) => test.applied > 0);
  const status: MutantStatus = killedBy.length > 0 ? 'killed' : reached ? 'survived' : 'unreached';
  return { status, killedBy, crashed };
}

/**
 * The tests that are evidence for a card: its manifest engine test IDs that resolve to exactly one
 * collected test. Contract tests (built on stand-in cards) and bulk-only IDs are not; an ID that
 * does not resolve is check:manifest-tests' failure, not this run's.
 */
export function cardTests(
  manifestJson: string,
  card: string,
  index: TestIndex,
  readFile: (path: string) => string,
): CollectedTest[] {
  const tests = new Map<string, CollectedTest>();
  for (const reference of manifestReferences(manifestJson)) {
    if (reference.card !== card || reference.contract || reference.notExecutableInCi) continue;
    const result = checkReference(reference, index, readFile);
    if (result.problem === null && result.matches.length === 1) {
      const test = result.matches[0]!;
      tests.set(`${test.file}\0${test.fullName}`, test);
    }
  }
  return [...tests.values()];
}

export interface EquivalentMutant {
  mutant: string;
  reason: string;
}

/**
 * The manifest card entry's `equivalentMutants`: a survivor that cannot change anything in a state
 * the card can reach, recorded by label with the reason (a main-thread decision).
 */
export function equivalentMutants(manifestJson: string, card: string): EquivalentMutant[] {
  const manifest = JSON.parse(manifestJson) as {
    cards: Record<string, { name: string; equivalentMutants?: EquivalentMutant[] }>;
  };
  return (
    Object.values(manifest.cards).find((entry) => entry.name === card)?.equivalentMutants ?? []
  );
}

/** Each card's implementation status, by name. */
export function cardStatuses(manifestJson: string): Map<string, string> {
  const manifest = JSON.parse(manifestJson) as {
    cards: Record<string, { name: string; implementationStatus: string }>;
  };
  return new Map(
    Object.values(manifest.cards).map((entry) => [entry.name, entry.implementationStatus]),
  );
}

/**
 * A Vitest test-name pattern selecting exactly these tests. Vitest matches it against the file's
 * root-relative path, the suites and the test, joined by spaces; `vitest list` joins the suites
 * and test with ` > `.
 */
export function testNamePattern(tests: readonly CollectedTest[]): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^(?:${tests
      .map((test) => escape([test.file, ...test.fullName.split(' > ')].join(' ')))
      .join('|')})$`,
  );
}
