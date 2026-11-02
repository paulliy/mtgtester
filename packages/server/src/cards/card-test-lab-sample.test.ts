/**
 * The Card Test Lab sampler (ADR 0037): what a sampled pull request run plays, and the diff and
 * source readings that decide it.
 */
import { describe, expect, it } from 'vitest';
import {
  addedScenarios,
  boardSummary,
  capabilitiesNamed,
  changedScenarios,
  enclosingLiterals,
  fingerprint,
  formatLabIndex,
  isEnginePrimitiveSource,
  parseLabIndex,
  parseUnifiedDiff,
  pick,
  selectLabScenarios,
  specTests,
  stringLiterals,
  type LabScenario,
  type LabSelectionInput,
} from '../../../../scripts/contracts/lab-sample';
import { excludedTitlePattern } from '../../../../apps/web/e2e/lab-selection';

const SCENARIOS: LabScenario[] = [
  { id: 'a', title: 'A: draws', capabilities: ['Effect.draw', 'Ability.spell'] },
  { id: 'b', title: 'B: draws more', capabilities: ['Effect.draw', 'Ability.spell'] },
  { id: 'c', title: 'C: damage', capabilities: ['Effect.dealDamage', 'Keyword.haste'] },
  { id: 'd', title: 'D: haste', capabilities: ['Keyword.haste'] },
  { id: 'e', title: 'E: tapped', capabilities: ['Selector.tapped'] },
];

function input(overrides: Partial<LabSelectionInput> = {}): LabSelectionInput {
  return {
    scenarios: SCENARIOS,
    seed: 'seed',
    changed: new Set(),
    mentioned: new Set(),
    touchedCapabilities: new Set(),
    latest: new Set(),
    sample: false,
    perFamily: 1,
    ...overrides,
  };
}

const ids = (selection: ReturnType<typeof selectLabScenarios>) =>
  selection.selected.map(({ id }) => id);

describe('selectLabScenarios', () => {
  it('selects nothing without a sample or a targeted scenario, and excludes every title', () => {
    const selection = selectLabScenarios(input());
    expect(selection.selected).toEqual([]);
    expect(selection.excludedTitles).toEqual(
      [...SCENARIOS.flatMap(({ id, title }) => [id, title])].sort(),
    );
  });

  it('always runs changed, mentioned and latest scenarios, with their reasons', () => {
    const selection = selectLabScenarios(
      input({
        changed: new Set(['a']),
        mentioned: new Set(['C: damage']),
        latest: new Set(['a', 'e']),
      }),
    );
    expect(selection.selected).toEqual([
      { id: 'a', title: 'A: draws', reasons: ['changed', 'latest'] },
      { id: 'c', title: 'C: damage', reasons: ['mentioned'] },
      { id: 'e', title: 'E: tapped', reasons: ['latest'] },
    ]);
    expect(selection.excludedTitles).not.toContain('a');
    expect(selection.excludedTitles).toContain('B: draws more');
  });

  it('draws one scenario for each touched engine primitive', () => {
    const selection = selectLabScenarios(
      input({ touchedCapabilities: new Set(['Keyword.haste']) }),
    );
    expect(selection.selected).toHaveLength(1);
    expect(['c', 'd']).toContain(selection.selected[0]!.id);
    expect(selection.selected[0]!.reasons).toEqual(['engine:Keyword.haste']);
  });

  it('samples one primitive, and one scenario reading it, from every family', () => {
    const selection = selectLabScenarios(input({ sample: true }));
    const families = new Set(
      selection.selected.flatMap(({ reasons }) =>
        reasons.map((reason) => reason.replace(/^family:/, '').split('.')[0]),
      ),
    );
    expect(families).toEqual(new Set(['Ability', 'Effect', 'Keyword', 'Selector']));
    expect(selection.selected.length).toBeLessThanOrEqual(4);
  });

  it('is deterministic for a seed and varies across seeds', () => {
    const first = ids(selectLabScenarios(input({ sample: true })));
    expect(ids(selectLabScenarios(input({ sample: true })))).toEqual(first);
    const seen = new Set<string>();
    for (let index = 0; index < 40; index++)
      for (const id of ids(selectLabScenarios(input({ sample: true, seed: `seed-${index}` }))))
        seen.add(id);
    expect(seen).toEqual(new Set(SCENARIOS.map(({ id }) => id)));
  });

  it('draws up to perFamily distinct primitives per family', () => {
    const selection = selectLabScenarios(input({ sample: true, perFamily: 2 }));
    const effects = selection.selected.flatMap(({ reasons }) =>
      reasons.filter((reason) => reason.startsWith('family:Effect.')),
    );
    expect(new Set(effects)).toEqual(new Set(['family:Effect.dealDamage', 'family:Effect.draw']));
    expect(() => selectLabScenarios(input({ perFamily: 0 }))).toThrow(/perFamily/);
  });

  it('leaves out a hand-titled test only when every scenario it names is unselected', () => {
    const selection = selectLabScenarios(
      input({
        changed: new Set(['a']),
        tests: [
          { title: 'walks A then B', literals: ['A: draws', 'B: draws more'] },
          { title: 'walks B', literals: ['b', 'Lab Ox'] },
          { title: 'names no scenario', literals: ['Lab Ox'] },
          { title: 'A: draws', literals: [] },
        ],
      }),
    );
    expect(selection.excludedTitles).toContain('walks B');
    expect(selection.excludedTitles).not.toContain('walks A then B');
    expect(selection.excludedTitles).not.toContain('names no scenario');
    expect(selection.excludedTitles).not.toContain('A: draws');
  });
});

describe('diff readings', () => {
  const diff = [
    'diff --git a/src/x.ts b/src/x.ts',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -3,0 +4,2 @@ function f() {',
    "+  case 'draw':",
    '+    return 1;',
    '@@ -10,1 +11,0 @@',
    "-  if (op === 'gone') return;",
    'diff --git a/src/old.ts b/src/old.ts',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    "-export const ID = 'removed-id';",
  ].join('\n');

  it('parses new-side lines and the changed text, keeping deleted files for their text', () => {
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: 'src/x.ts',
        lines: [4, 5, 11],
        text: ["  case 'draw':", '    return 1;', "  if (op === 'gone') return;"],
      },
      { path: '', lines: [1], text: ["export const ID = 'removed-id';"] },
    ]);
  });

  it('reads string literals of every quote style', () => {
    expect(stringLiterals(`a('x', "y\\"z", \`t\`, \`no \${interp}\`)`)).toEqual(['x', 'y"z', 't']);
  });

  it('finds the case labels, compared literals, test titles and ids around changed lines', () => {
    const source = [
      'switch (effect.op) {', // 1
      "  case 'draw': {", // 2
      '    count += 1;', // 3
      '  }', // 4
      '}', // 5
      "if (kind === 'tapped') {", // 6
      '  run();', // 7
      '}', // 8
      "test('A: draws', async () => {", // 9
      '  await go();', // 10
      '});', // 11
      "const s = { id: 'scenario-x', seats: [", // 12
      '  1,', // 13
      '] };', // 14
      "entry(CARD, 'mode', 'Scenario title', {", // 15
      '  p1Hand: [],', // 16
      '});', // 17
    ].join('\n');
    expect(enclosingLiterals('x.ts', source, [3, 7, 10, 13, 16])).toEqual([
      'A: draws',
      'draw',
      'scenario-x',
      'tapped',
    ]);
    expect(enclosingLiterals('x.ts', source, [16], true)).toEqual(['Scenario title', 'mode']);
  });

  it('reads each literal-titled test with the literals in its body', () => {
    const source = [
      "test('walks A', async ({ page }) => { await runScenario(page, 'A: draws'); });",
      "test.describe('group', () => { test('inner', () => use('b')); });",
      'for (const id of IDS) test(id, () => {});',
    ].join('\n');
    expect(specTests('x.spec.ts', source)).toEqual([
      { title: 'walks A', literals: ['A: draws'] },
      { title: 'inner', literals: ['b'] },
    ]);
  });

  it('maps engine literals to capabilities and keeps overrides and tests out of the engine set', () => {
    expect(
      capabilitiesNamed(['Effect.draw', 'Selector.tapped', 'Value.x'], new Set(['draw', 'tapped'])),
    ).toEqual(new Set(['Effect.draw', 'Selector.tapped']));
    expect(isEnginePrimitiveSource('packages/engine/src/effects/resolve.ts')).toBe(true);
    expect(isEnginePrimitiveSource('packages/engine/src/cards/overrides/foo.ts')).toBe(false);
    expect(isEnginePrimitiveSource('packages/engine/src/effects/resolve.test.ts')).toBe(false);
    expect(isEnginePrimitiveSource('packages/server/src/cards/x.ts')).toBe(false);
  });
});

describe('the scenario index', () => {
  it('fingerprints canonical JSON regardless of key order, Maps and Sets', () => {
    expect(fingerprint({ a: 1, b: new Set([2]) })).toBe(fingerprint({ b: [2], a: 1 }));
    expect(fingerprint(new Map([['k', 1]]))).toBe(fingerprint({ k: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it('summarises a board by card placement, not by engine-internal fields', () => {
    const state = (extra: Record<string, unknown>) => ({
      turnNumber: 1,
      players: [{ life: 40, hand: [{ oracleId: 'o1', internal: 1, ...extra }] }],
      battlefield: [{ oracleId: 'o2', tapped: true }],
      eventLog: [{ oracleId: 'ignored' }],
    });
    expect(boardSummary(state({}))).toEqual(boardSummary(state({ internal: 2, newField: 'x' })));
    expect(boardSummary(state({}))).toEqual({
      cards: ['battlefield:o2[tapped=true]', 'players.hand:o1'],
      life: [40],
      turn: [1, undefined, undefined, undefined],
    });
  });

  it('round-trips and reports changed and added scenarios', () => {
    const base = parseLabIndex(formatLabIndex({ b: '2', a: '1' }));
    expect(Object.keys(base.scenarios)).toEqual(['a', 'b']);
    const current = parseLabIndex(formatLabIndex({ a: '1', b: '3', c: '4' }));
    expect(changedScenarios(current, base)).toEqual(new Set(['b', 'c']));
    expect(addedScenarios(current, base)).toEqual(new Set(['c']));
    expect(() => parseLabIndex('{"schemaVersion":2}')).toThrow(/schemaVersion 1/);
  });
});

describe('excludedTitlePattern', () => {
  it('matches a whole excluded title at the end of the title path', () => {
    const pattern = excludedTitlePattern(['A: draws (x)', 'b'])!;
    expect(pattern.test('chromium card-test-lab.spec.ts A: draws (x)')).toBe(true);
    expect(pattern.test(' Group b')).toBe(true);
    expect(pattern.test(' Group ab')).toBe(false);
    expect(pattern.test(' A: draws (x) more')).toBe(false);
    expect(excludedTitlePattern([])).toBeUndefined();
  });

  it('picks deterministic indexes within range', () => {
    for (let size = 1; size < 10; size++) expect(pick('s', 'k', size)).toBeLessThan(size);
    expect(() => pick('s', 'k', 0)).toThrow();
  });
});
