/** ADR 0034 decision 5: each manifest engine test ID names exactly one collected test. */
import { describe, expect, it } from 'vitest';
import {
  bulkReferenceProblem,
  cardNames,
  checkReference,
  indexTests,
  manifestReferences,
  mentionsCard,
  type CollectedTest,
  type ManifestReference,
} from '../../../../scripts/contracts/manifest-tests';

const reference = (id: string, change: Partial<ManifestReference> = {}): ManifestReference => ({
  card: 'Tribute Mage',
  oracleId: 'c2b51295-8820-425f-a517-55231123c7de',
  id,
  sources: [],
  notExecutableInCi: false,
  contract: false,
  ...change,
});

const tests: CollectedTest[] = [
  {
    file: 'packages/engine/tests/tribute-mage.test.ts',
    fullName: 'Tribute Mage > tribute-decline-search — leaves eligible cards in the library',
  },
  {
    file: 'packages/engine/tests/tribute-mage.test.ts',
    fullName: 'Tribute Mage > tribute-decline-search-twice — declines on both triggers',
  },
  {
    file: 'packages/engine/tests/counter.test.ts',
    fullName: 'Negate > reject-self — rejects its own proposed stack incarnation',
  },
  {
    file: 'packages/engine/tests/counter.test.ts',
    fullName: 'Counterspell > reject-self — rejects its own proposed stack incarnation',
  },
  {
    file: 'packages/engine/tests/other.test.ts',
    fullName: 'other > tribute-normal-cast-etb — pays its mana cost',
  },
  {
    file: 'packages/engine/tests/scenario/scenarios.test.ts',
    fullName: "lab > 'tribute-mage-viewer-search' — applies the expected outcome",
  },
];
const sources: Record<string, string> = {
  'packages/engine/tests/tribute-mage.test.ts': "describe('Tribute Mage', () => {});",
  'packages/engine/tests/counter.test.ts': "it.each(['Negate', 'Counterspell'])",
  'packages/engine/tests/other.test.ts': 'a test about some other card',
  'packages/engine/tests/scenario/scenarios.test.ts': '',
};
const index = indexTests(tests);
const check = (ref: ManifestReference) => checkReference(ref, index, (path) => sources[path]!);

describe('manifest test references', () => {
  it('matches a title equal to the ID or continuing it with an em dash, and nothing longer', () => {
    const result = check(reference('tribute-decline-search'));
    expect(result.problem).toBeNull();
    expect(result.matches.map((test) => test.fullName)).toEqual([
      'Tribute Mage > tribute-decline-search — leaves eligible cards in the library',
    ]);
    expect(check(reference('tribute-decline')).problem).toBe('matches no collected test');
    expect(
      check(reference('Tribute Mage > tribute-decline-search-twice — declines on both triggers'))
        .problem,
    ).toBeNull();
  });

  it('reads a quoted leading parameter unquoted', () => {
    expect(check(reference('tribute-mage-viewer-search')).problem).toBeNull();
  });

  it('fails an ID several tests match unless the card narrows it to one', () => {
    const narrowed = check(reference('reject-self', { card: 'Negate' }));
    expect(narrowed.problem).toBeNull();
    expect(narrowed.matches.map((test) => test.fullName)).toEqual([
      'Negate > reject-self — rejects its own proposed stack incarnation',
    ]);
    const ambiguous = check(reference('reject-self', { card: 'Mana Leak' }));
    expect(ambiguous.problem).toMatch(/^matches 2 tests: /);
  });

  it('narrows by a file:: prefix and by the clause engineTestSource', () => {
    expect(check(reference('tribute-mage.test.ts::tribute-decline-search')).problem).toBeNull();
    expect(check(reference('counter.test.ts::tribute-decline-search')).problem).toBe(
      'matches no collected test',
    );
    expect(
      check(
        reference('tribute-decline-search', { sources: ['packages/engine/tests/other.test.ts'] }),
      ).problem,
    ).toBe('matches no collected test');
  });

  it('fails a test whose file and title never name the card, unless it is a contract test', () => {
    expect(check(reference('tribute-normal-cast-etb')).problem).toBe(
      'matches packages/engine/tests/other.test.ts, which never names Tribute Mage',
    );
    expect(check(reference('tribute-normal-cast-etb', { contract: true })).problem).toBeNull();
  });

  it('holds a notExecutableInCi ID to a tracked file, and fails one CI collects', () => {
    const bulk = reference('path-engine-normal-cast', { notExecutableInCi: true });
    expect(check(bulk).problem).toBeNull();
    expect(
      bulkReferenceProblem(bulk, new Map([['a.test.ts', "it('path-engine-normal-cast')"]])),
    ).toBeNull();
    expect(bulkReferenceProblem(bulk, new Map([['a.test.ts', '']]))).toMatch(
      /no tracked test file holds its text/,
    );
    expect(check(reference('tribute-decline-search', { notExecutableInCi: true })).problem).toBe(
      'is marked notExecutableInCi but runs in CI',
    );
  });

  it('names a card by any face, its slug, escaped or curly quotes, or a legend short name', () => {
    expect(cardNames('Ettercap // Web Shot')).toEqual([
      'Ettercap // Web Shot',
      'Ettercap',
      'Web Shot',
    ]);
    expect(cardNames('Scriv, the Obligator')).toContain('Scriv');
    expect(mentionsCard("it('Web Shot destroys a flier')", 'Ettercap // Web Shot')).toBe(true);
    expect(mentionsCard("'Angel\\'s Grace'", "Angel's Grace")).toBe(true);
    expect(mentionsCard('Angel’s Grace', "Angel's Grace")).toBe(true);
    expect(mentionsCard('tribute-mage-viewer', 'Tribute Mage')).toBe(true);
    expect(mentionsCard('Tribute', 'Tribute Mage')).toBe(false);
  });

  it('reads card-level, clause, contract, and bulk-only references from the manifest', () => {
    const manifest = JSON.stringify({
      cards: {
        id1: {
          name: 'Card One',
          engineTestIds: ['card-level'],
          clauses: [
            {
              engineTestIds: ['plain', { id: 'flagged', notExecutableInCi: true }, 'listed'],
              contractTestIds: ['shared'],
              engineTestSource: 'one.test.ts',
              notExecutableInCi: ['listed'],
            },
          ],
        },
      },
    });
    expect(
      manifestReferences(manifest).map(({ id, sources, notExecutableInCi, contract }) => ({
        id,
        sources,
        notExecutableInCi,
        contract,
      })),
    ).toEqual([
      { id: 'card-level', sources: [], notExecutableInCi: false, contract: false },
      { id: 'plain', sources: ['one.test.ts'], notExecutableInCi: false, contract: false },
      { id: 'flagged', sources: ['one.test.ts'], notExecutableInCi: true, contract: false },
      { id: 'listed', sources: ['one.test.ts'], notExecutableInCi: true, contract: false },
      { id: 'shared', sources: ['one.test.ts'], notExecutableInCi: false, contract: true },
    ]);
  });
});
