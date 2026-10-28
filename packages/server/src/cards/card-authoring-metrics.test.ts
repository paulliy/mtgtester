import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addedFixtureNames,
  changedManifestCards,
  classifyPath,
  countPumpCalls,
  emptyLines,
  indexStringLiterals,
  isCompoundOp,
  isPumpScanFile,
  keywordCardsIn,
  linesByCategory,
  manifestIdShape,
  manifestTestIds,
  median,
  mentionsCard,
  parseNumstat,
  parsePatch,
  pathNamesCard,
  rankKeywords,
  textNamesCard,
  touchKind,
  unionDiscriminants,
} from '../../../../scripts/contracts/card-authoring-metrics';
import { ABILITY_SOURCE } from '../../../../scripts/contracts/card-names';
import {
  cardNameSlugs,
  checkCardNamedOps,
  effectOps,
  slugTable,
} from '../../../../scripts/contracts/ratchets';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('classifyPath', () => {
  it.each([
    ['packages/engine/tests/fixtures/override-defs.json', 'generated'],
    ['packages/engine/tests/fixtures/coverage-pr11-oracle.json', 'generated'],
    ['benchmarks/tactician/dev/priority-removal-001.json', 'generated'],
    ['packages/engine/tests/__snapshots__/x.test.ts.snap', 'generated'],
    ['packages/server/fixtures/coverage-oracle.json', 'generated'],
    ['docs/reviews/war-room-gameplay-ai.json', 'generated'],
    ['packages/engine/tests/pr11-lifecycle.test.ts', 'tests'],
    ['packages/engine/tests/pr11-helpers.ts', 'tests'],
    ['packages/engine/tests/fixtures.ts', 'tests'],
    ['packages/server/src/cards/pr11-scenarios.test.ts', 'tests'],
    ['apps/web/e2e/pr11-card-test-lab.spec.ts', 'tests'],
    ['packages/server/src/cards/pr11-scenarios.ts', 'scenarios'],
    ['packages/server/src/cards/pr11-scenario-catalog.ts', 'scenarios'],
    ['packages/server/fixtures/card-verification-manifest.json', 'manifestAndDocs'],
    ['docs/plans/pr11-progress.md', 'manifestAndDocs'],
    ['docs/plans/card-coverage-ledger.json', 'manifestAndDocs'],
    ['packages/engine/src/cards/ability.ts', 'opTables'],
    ['packages/engine/src/cards/expression-validation.ts', 'opTables'],
    ['packages/engine/src/cards/effect-reference-contracts.ts', 'opTables'],
    ['packages/engine/src/cards/capabilities.ts', 'opTables'],
    ['packages/engine/src/effects/resolve.ts', 'resolve'],
    ['packages/engine/src/cards/overrides/coverage-pr11.ts', 'engineCards'],
    ['packages/engine/src/cards/interpret.ts', 'engineCards'],
    ['packages/engine/src/state/queries.ts', 'engineSrcOther'],
    ['packages/engine/src/effects/other.ts', 'engineSrcOther'],
    ['scripts/generate-war-room-evidence.ts', 'other'],
    ['package.json', 'other'],
  ] as const)('puts %s in %s', (path, category) => {
    expect(classifyPath(path)).toBe(category);
  });

  it('keeps the hand-written manifest out of generated, which owns the rest of server fixtures', () => {
    expect(classifyPath('packages/server/fixtures/card-verification-manifest.json')).not.toBe(
      'generated',
    );
    expect(classifyPath('packages/server/fixtures/white-black-control-oracle.json')).toBe(
      'generated',
    );
  });

  it('decides which files count as per-card evidence', () => {
    expect(touchKind('packages/engine/src/cards/overrides/coverage-pr11.ts')).toBe('override');
    expect(touchKind('packages/engine/tests/pr11-lifecycle.test.ts')).toBe('test');
    expect(touchKind('packages/server/src/cards/pr11-scenarios.ts')).toBe('scenario');
    expect(touchKind('packages/server/fixtures/card-verification-manifest.json')).toBe('manifest');
    expect(touchKind('packages/engine/src/effects/resolve.ts')).toBeUndefined();
    expect(touchKind('packages/engine/tests/fixtures/override-defs.json')).toBeUndefined();
  });
});

describe('line counting', () => {
  it('reads numstat rows, counting binary files as zero', () => {
    const rows = parseNumstat(
      '12\t3\tpackages/engine/src/effects/resolve.ts\n-\t-\tdocs/image.png\n5\t0\tpackages/engine/tests/a.test.ts\n',
    );
    expect(rows).toEqual([
      { path: 'packages/engine/src/effects/resolve.ts', added: 12, deleted: 3 },
      { path: 'docs/image.png', added: 0, deleted: 0 },
      { path: 'packages/engine/tests/a.test.ts', added: 5, deleted: 0 },
    ]);
    const lines = linesByCategory(rows);
    expect(lines.resolve).toBe(15);
    expect(lines.tests).toBe(5);
    expect(lines.manifestAndDocs).toBe(0);
  });

  it('keeps changed lines per file from a zero-context patch', () => {
    const files = parsePatch(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,1 +1,2 @@',
        '-old',
        '+new',
        '+Mana Vault',
        'diff --git a/b.ts b/b.ts',
        '--- a/b.ts',
        '+++ b/b.ts',
        '@@ -3 +3 @@',
        '-x',
      ].join('\n'),
    );
    expect(files).toEqual([
      { path: 'a.ts', changed: ['old', 'new', 'Mana Vault'] },
      { path: 'b.ts', changed: ['x'] },
    ]);
    expect(emptyLines().generated).toBe(0);
  });

  it('takes the median of odd and even lists', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});

describe('card name matching', () => {
  it('matches whole words in changed lines, by face and by a legend short name', () => {
    expect(mentionsCard('Mana Vault', "it('Mana Vault untaps', () => {")).toBe(true);
    expect(mentionsCard('Gut, True Soul Zealot', 'const gut = card("Gut")')).toBe(true);
    expect(mentionsCard('Gut, True Soul Zealot', 'a gutter')).toBe(false);
    expect(mentionsCard('Wear // Tear', 'cast Tear from hand')).toBe(true);
    expect(mentionsCard("Urza's Saga", "name: 'Urza\\'s Saga'")).toBe(true);
    expect(mentionsCard('Mana Vault', 'Mana Vaulted')).toBe(false);
  });

  it('matches test file names and fix commit text', () => {
    expect(pathNamesCard('Caged Sun', 'packages/engine/tests/caged-sun.test.ts')).toBe(true);
    expect(pathNamesCard("Angel's Grace", 'packages/engine/tests/angels-grace.test.ts')).toBe(true);
    expect(pathNamesCard('Caged Sun', 'packages/engine/tests/chrome-mox.test.ts')).toBe(false);
    expect(textNamesCard('Chrome Mox', 'fix(engine): chrome mox reads hand card types')).toBe(true);
    expect(textNamesCard('Chrome Mox', 'fix(engine): chrome moxen')).toBe(false);
  });

  it('reads the names a diff adds to a pinned fixture', () => {
    expect(
      addedFixtureNames([
        '    "name": "Arcane Lighthouse",',
        '    "name": "Urza\'s Saga"',
        '    "oracleText": "x"',
        '        "name": "Dollmaker\\"s"',
      ]),
    ).toEqual(['Arcane Lighthouse', "Urza's Saga", 'Dollmaker"s']);
  });

  it('finds the manifest entries that differ between two texts', () => {
    const manifest = (text: string) =>
      JSON.stringify({ cards: { a: { name: 'A', t: text }, b: { name: 'B', t: 'same' } } });
    expect(changedManifestCards(manifest('1'), manifest('2'))).toEqual([
      { oracleId: 'a', name: 'A' },
    ]);
    expect(changedManifestCards(undefined, manifest('2')).map((card) => card.name)).toEqual([
      'A',
      'B',
    ]);
  });
});

describe('compound ops and card-named ops', () => {
  it('flags And and Then inside a name, not words that merely contain them', () => {
    for (const op of [
      'reanimateAndLoseLife',
      'sacrificeOneThen',
      'separatePermanentsIntoPilesThenSacrifice',
    ])
      expect(isCompoundOp(op), op).toBe(true);
    for (const op of ['destroy', 'bandThemed', 'standardRows', 'islandHome', 'thenceforth'])
      expect(isCompoundOp(op), op).toBe(false);
  });

  it('agrees with the ratchet on every Effect op, so the two cannot drift apart', () => {
    const ops = effectOps(ABILITY_SOURCE, read(ABILITY_SOURCE));
    expect(ops.length).toBeGreaterThan(100);
    for (const op of ops) {
      const flagged = checkCardNamedOps({ baseOps: [], headOps: [op], slugs: {} }).warnings;
      expect(isCompoundOp(op), op).toBe(flagged.length > 0);
    }
  });

  it('counts an op that equals a card-name slug, and nothing else', () => {
    const slugs = slugTable([
      "Angel's Grace",
      'Kambal, Consul of Allocation',
      'Master of Ceremonies',
    ]);
    expect(cardNameSlugs("Angel's Grace")).toContain('angelGrace');
    const result = checkCardNamedOps({
      baseOps: undefined,
      headOps: ['angelGrace', 'kambal', 'masterOfCeremonies', 'draw', 'angelGraceTwice'],
      slugs,
    });
    expect(result.cardNamed).toEqual(['angelGrace', 'kambal', 'masterOfCeremonies']);
  });

  it('reads the kinds of a RuleStatic union, and rejects a member without one', () => {
    const source = `export type RuleStatic =
      | { kind: 'cantBeSacrificed' }
      /** doc */
      | { kind: 'opponentCostIncrease'; amount: number };`;
    expect(unionDiscriminants('r.ts', source, 'RuleStatic', 'kind')).toEqual([
      'cantBeSacrificed',
      'opponentCostIncrease',
    ]);
    expect(() =>
      unionDiscriminants(
        'r.ts',
        'export type RuleStatic = { kind: string };',
        'RuleStatic',
        'kind',
      ),
    ).toThrow(/string-literal/);
    expect(() =>
      unionDiscriminants('r.ts', 'export type Other = {};', 'RuleStatic', 'kind'),
    ).toThrow(/no `RuleStatic`/);
  });
});

describe('pump() arity', () => {
  it('counts bare pump calls by argument count from the AST', () => {
    const source = `
      import { pump } from './fixtures';
      const a = pump(gen);
      const b = pump<number>(gen2());
      const c = pump(gen, (decision) => outcome(decision));
      const d = pump(...args);
      const e = pump();
      const f = pump(nested(pump(inner)));
      const text = 'pump(not, code)'; // pump(also, not)
      const g = helper.pump(x);
      const pump2 = pump;
    `;
    expect(countPumpCalls('t.ts', source)).toEqual({ oneArg: 4, twoArg: 1, other: 2 });
  });

  it('does not count a local variable named pump that is never called', () => {
    expect(countPumpCalls('t.ts', "const pump = kind === 'pump';")).toEqual({
      oneArg: 0,
      twoArg: 0,
      other: 0,
    });
  });

  it('scans packages tests and .test.ts files, not declarations or other sources', () => {
    expect(isPumpScanFile('packages/engine/tests/a.ts')).toBe(true);
    expect(isPumpScanFile('packages/server/src/cards/a.test.ts')).toBe(true);
    expect(isPumpScanFile('packages/engine/tests/a.d.ts')).toBe(false);
    expect(isPumpScanFile('packages/engine/src/a.ts')).toBe(false);
    expect(isPumpScanFile('apps/web/e2e/a.spec.ts')).toBe(false);
  });
});

describe('manifest test-ID shapes', () => {
  const index = indexStringLiterals(`
    it('exact title of a test', () => {});
    it('pr10-mana-sculpt — counters without adding mana', () => {});
    const tpl = \`built-\${n}\`;
  `);

  it('classifies each shape and reads literals but not templates', () => {
    expect(manifestIdShape('white-black-control-x.test.ts::some title', index)).toBe(
      'fileQualified',
    );
    expect(manifestIdShape('exact title of a test', index)).toBe('exactTitle');
    expect(manifestIdShape('pr10-mana-sculpt', index)).toBe('titlePrefixDash');
    expect(manifestIdShape('built-1', index)).toBe('noLiteral');
    expect(manifestIdShape('never-written', index)).toBe('noLiteral');
  });

  it('collects ids at clause and card level, including object ids', () => {
    const manifest = JSON.stringify({
      cards: {
        a: {
          engineTestIds: ['card-level'],
          clauses: [{ engineTestIds: ['one', { id: 'two', notExecutableInCi: true }] }],
        },
      },
    });
    expect(manifestTestIds(manifest)).toEqual(['card-level', 'one', 'two']);
  });
});

describe('keyword ranking', () => {
  it('ranks keywords by distinct cards across bulk and projection shapes, deduplicating by Oracle id', () => {
    const cards = keywordCardsIn({
      cards: [
        {
          card: {
            oracleId: 'a',
            name: 'A',
            keywords: ['Flying', 'Haste'],
            commanderLegality: 'legal',
          },
        },
        { oracle_id: 'b', name: 'B', keywords: ['Flying'], legalities: { commander: 'not_legal' } },
        {
          oracleId: 'a',
          name: 'A again',
          keywords: ['Flying', 'Haste'],
          commanderLegality: 'legal',
        },
        {
          oracle_id: 'c',
          name: 'C',
          keywords: ['Haste', 'Haste'],
          legalities: { commander: 'legal' },
        },
        { name: 'No keywords field' },
      ],
    });
    expect(cards.size).toBe(3);
    expect(rankKeywords(cards.values())).toEqual([
      { keyword: 'Flying', cards: 2, commanderLegalCards: 1 },
      { keyword: 'Haste', cards: 2, commanderLegalCards: 2 },
    ]);
  });

  it('leaves the legality column out when no source carries one', () => {
    const ranking = rankKeywords([{ id: 'x', name: 'X', keywords: ['Ward'] }]);
    expect(ranking).toEqual([{ keyword: 'Ward', cards: 1, commanderLegalCards: undefined }]);
  });
});
