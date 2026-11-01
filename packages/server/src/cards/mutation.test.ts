/** ADR 0034 decision 5: how an IR mutant's run is judged, and which tests are a card's evidence. */
import { describe, expect, it } from 'vitest';
import { indexTests } from '../../../../scripts/contracts/manifest-tests';
import {
  cardTests,
  equivalentMutants,
  judgeMutant,
  mutationNotProven,
  testNamePattern,
  type MutantTestResult,
} from '../../../../scripts/contracts/mutation';

const result = (change: Partial<MutantTestResult>): MutantTestResult => ({
  fullName: 'Card > test',
  state: 'passed',
  errorNames: [],
  applied: 1,
  ...change,
});

describe('judging a mutant', () => {
  it('is killed only by a failed assertion', () => {
    expect(
      judgeMutant([
        result({ fullName: 'a', state: 'failed', errorNames: ['AssertionError'] }),
        result({ fullName: 'b', state: 'failed', errorNames: ['TypeError'] }),
      ]),
    ).toEqual({ status: 'killed', killedBy: ['a'], crashed: ['b'] });
  });

  it('survives a crash, a timeout or a strict driver, and passing tests', () => {
    expect(
      judgeMutant([
        result({ fullName: 'crash', state: 'failed', errorNames: ['EngineInvariantError'] }),
        result({ fullName: 'timeout', state: 'failed', errorNames: ['Error'] }),
        result({ fullName: 'pass' }),
      ]),
    ).toEqual({ status: 'survived', killedBy: [], crashed: ['crash', 'timeout'] });
  });

  it('is unreached when the hook never applied it, even if a test fails another way', () => {
    expect(
      judgeMutant([result({ applied: 0 }), result({ state: 'failed', applied: 0 })]).status,
    ).toBe('unreached');
  });
});

describe("a card's evidence", () => {
  const manifest = JSON.stringify({
    cards: {
      one: {
        name: 'Tribute Mage',
        equivalentMutants: [{ mutant: 'triggers[0]: flip optional to true', reason: 'r' }],
        engineTestIds: ['tribute-normal-cast-etb'],
        clauses: [
          {
            engineTestIds: ['tribute-decline-search', 'missing-test'],
            contractTestIds: ['shared-contract'],
            notExecutableInCi: [],
          },
        ],
      },
    },
  });
  const index = indexTests([
    { file: 'tribute-mage.test.ts', fullName: 'Tribute Mage > tribute-normal-cast-etb — casts it' },
    { file: 'tribute-mage.test.ts', fullName: 'Tribute Mage > tribute-decline-search — declines' },
    { file: 'contract.test.ts', fullName: 'contracts > shared-contract — stands in' },
  ]);

  it('is its resolved manifest tests, not contract tests or IDs that resolve to nothing', () => {
    expect(
      cardTests(manifest, 'Tribute Mage', index, () => "describe('Tribute Mage')").map(
        (test) => test.fullName,
      ),
    ).toEqual([
      'Tribute Mage > tribute-normal-cast-etb — casts it',
      'Tribute Mage > tribute-decline-search — declines',
    ]);
  });

  it('records equivalent mutants by label', () => {
    expect(equivalentMutants(manifest, 'Tribute Mage')).toEqual([
      { mutant: 'triggers[0]: flip optional to true', reason: 'r' },
    ]);
    expect(equivalentMutants(manifest, 'Path to Exile')).toEqual([]);
  });

  it('selects exactly those tests by the name Vitest matches: file, suites and test', () => {
    const pattern = testNamePattern([{ file: 'a.test.ts', fullName: 'Card (x) > id — does [it]' }]);
    expect(pattern.test('a.test.ts Card (x) id — does [it]')).toBe(true);
    expect(pattern.test('a.test.ts Card (x) id — does [it] again')).toBe(false);
    expect(pattern.test('a.test.ts Other Card (x) id — does [it]')).toBe(false);
    expect(pattern.test('b/a.test.ts Card (x) id — does [it]')).toBe(false);
  });
});

describe('which reviewed cards fail the mutation run', () => {
  const outcome = (change: Partial<Parameters<typeof mutationNotProven>[0]>) => ({
    status: 'implemented-reviewed',
    tests: 3,
    mutants: [{ status: 'killed' as const }],
    baselineFailures: [],
    ...change,
  });

  it('passes a reviewed card whose mutants are all killed or equivalent', () => {
    expect(
      mutationNotProven(outcome({ mutants: [{ status: 'killed' }, { status: 'equivalent' }] })),
    ).toBe(false);
  });

  it('fails a reviewed card with no resolvable test, not vacuously passing it', () => {
    expect(mutationNotProven(outcome({ tests: 0, mutants: [] }))).toBe(true);
  });

  it('fails a survivor, an unreached mutant and a baseline failure', () => {
    expect(mutationNotProven(outcome({ mutants: [{ status: 'survived' }] }))).toBe(true);
    expect(mutationNotProven(outcome({ mutants: [{ status: 'unreached' }] }))).toBe(true);
    expect(mutationNotProven(outcome({ baselineFailures: ['(some tests did not run)'] }))).toBe(
      true,
    );
  });

  it('only reports on cards that are not reviewed', () => {
    expect(mutationNotProven(outcome({ status: 'implemented', tests: 0, mutants: [] }))).toBe(
      false,
    );
  });
});
