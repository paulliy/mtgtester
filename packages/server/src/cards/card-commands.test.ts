/** The authoring commands' pure parts (ADR 0033 decision 1, plan phase 2). */
import { describe, expect, it } from 'vitest';
import { lineDiff, snapshotChange } from '../../../../scripts/cards/card-check';
import {
  batchCards,
  bindSources,
  registerScenarioFiles,
  snapshotChanges,
  sourceList,
} from '../../../../scripts/cards/card-finish';
import {
  batchFileSource,
  forgeScriptPath,
  insertStub,
  interactionPrompts,
  manifestEntry,
  nearestCards,
  normalizeLine,
  overrideStub,
  runnerTestSource,
  similarity,
  wireBatch,
} from '../../../../scripts/cards/card-new';
import type { OracleCard } from '@mtg/shared';

const card = (name: string, oracleText: string): OracleCard =>
  ({ oracleId: `id-${name}`, name, oracleText }) as OracleCard;

describe('card:check', () => {
  it('diffs two texts line by line', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual(['- b', '+ x']);
    expect(lineDiff('a\nb', 'a\nb')).toEqual([]);
    expect(lineDiff('', 'a')).toEqual(['- ', '+ a']);
  });

  it("reports one card's override snapshot change, and nothing for other cards", () => {
    const entry = (id: string, op: string) => ({
      oracleId: id,
      name: id,
      handledLines: [],
      def: { op },
    });
    const baseline = JSON.stringify([entry('a', 'draw'), entry('b', 'gain')]);
    const current = JSON.stringify([entry('a', 'draw'), entry('b', 'lose')]);
    expect(snapshotChange(baseline, current, 'a')).toEqual([]);
    expect(snapshotChange(baseline, current, 'b')).toEqual([
      expect.stringMatching(/^- .*"op": "gain"/),
      expect.stringMatching(/^\+ .*"op": "lose"/),
    ]);
    expect(snapshotChange(baseline, current, 'z')).toBeNull();
  });
});

describe('card:new', () => {
  it('raises the interaction questions for the clause shapes in the text', () => {
    expect(
      interactionPrompts(
        'Whenever another creature you control dies, if it had a +1/+1 counter, you may draw a card.',
      ).map(({ shape }) => shape),
    ).toEqual(['"another"', '"you may"', 'intervening "if"']);
    expect(interactionPrompts('Flying')).toEqual([]);
  });

  it('ranks modeled lines by word overlap, the card name and numbers made generic', () => {
    expect(normalizeLine('Spit Flame deals 4 damage to target creature.', 'Spit Flame')).toEqual([
      'cardname',
      'deals',
      'num',
      'damage',
      'to',
      'target',
      'creature',
    ]);
    expect(similarity(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
    const corpus = [
      { card: 'Spit Flame', line: 'Spit Flame deals 4 damage to target creature.' },
      { card: 'Divination', line: 'Draw two cards.' },
      { card: 'Mortar', line: 'Mortar deals 4 damage to target creature.' },
    ].map((entry) => ({ ...entry, words: normalizeLine(entry.line, entry.card) }));
    expect(
      nearestCards('Mortar deals 4 damage to target creature you control.', 'Mortar', corpus).map(
        (near) => near.card,
      ),
    ).toEqual(['Spit Flame']);
  });

  it("finds a card's Forge script path the way Forge names its files", () => {
    expect(forgeScriptPath('Mizzium Mortars')).toBe(
      'forge-gui/res/cardsfolder/m/mizzium_mortars.txt',
    );
    expect(forgeScriptPath("Olórin's Searing Light")).toBe(
      'forge-gui/res/cardsfolder/o/olorins_searing_light.txt',
    );
  });

  it('writes an unimplemented() stub into a new or existing batch file, and wires the batch once', () => {
    const stub = overrideStub(card('Mortar', 'x'), ['~ deals 4 damage.']);
    expect(stub).toContain(
      'unimplemented("id-Mortar", "Mortar", [\n    "~ deals 4 damage.",\n  ]);',
    );
    const fresh = insertStub(batchFileSource('pilot-one'), stub);
    expect(fresh).toMatch(
      /export function registerPilotOneOverrides\(\): void \{\n {2}\/\/ card:new/,
    );
    expect(fresh.match(/^import \{ unimplemented \}/gm)).toHaveLength(1);
    const twice = insertStub(fresh, overrideStub(card('Other', 'y'), ['y']));
    expect(twice.indexOf('"Mortar"')).toBeLessThan(twice.indexOf('"Other"'));
    expect(twice.trimEnd().endsWith('}')).toBe(true);

    const index = [
      "import { a } from './a';",
      'function registerDeck(deck: string, register: () => void): void {}',
      "registerDeck('a', a);",
      'export const x = 1;',
    ].join('\n');
    const wired = wireBatch(index, 'pilot-one');
    expect(wired).toContain("import { registerPilotOneOverrides } from './pilot-one';");
    expect(wired).toContain(
      "registerDeck('a', a);\nregisterDeck('pilot-one', registerPilotOneOverrides);",
    );
    expect(wireBatch(wired, 'pilot-one')).toBe(wired);
  });

  it('scaffolds a manifest entry and runner tests that stay rejected until filled', () => {
    const entry = manifestEntry(card('Mortar', 'Line one.\nLine two.'), 'abc');
    expect(entry.clauses).toEqual([
      { oracleText: 'Line one.', implementation: [], engineTestIds: [] },
      { oracleText: 'Line two.', implementation: [], engineTestIds: [] },
    ]);
    const source = runnerTestSource(card('Mortar', 'Line one.'), 'pilot-one');
    expect(source.match(/it\.todo\(/g)).toHaveLength(2);
    expect(source).toContain('scenarios/mortar.json');
  });
});

describe('card:finish', () => {
  it('names each snapshot entry that was added, removed or changed', () => {
    const entry = (oracleId: string, name: string, op: string) => ({ oracleId, name, def: { op } });
    const changes = snapshotChanges(
      JSON.stringify([entry('a', 'Alpha', 'draw'), entry('b', 'Beta', 'gain')]),
      JSON.stringify([entry('a', 'Alpha', 'mill'), entry('c', 'Gamma', 'scry')]),
    );
    expect(changes.map(({ name, kind }) => [name, kind])).toEqual([
      ['Alpha', 'changed'],
      ['Beta', 'removed'],
      ['Gamma', 'added'],
    ]);
  });

  it('binds a missing source beside its closest sibling, as PR11b did by hand', () => {
    const generator = [
      'const SOURCE_FILES = [',
      "  'packages/engine/src/cards/overrides/coverage-pr09.ts',",
      "  'packages/engine/src/cards/overrides/coverage-pr11.ts',",
      "  'packages/engine/src/cards/overrides/coverage-pr12.ts',",
      "  'packages/server/src/cards/pr11-scenarios.ts',",
      "  'packages/server/src/cards/pr11b-scenarios.ts',",
      "  'packages/engine/src/cards/overrides/bug-hunt.ts',",
      "  'packages/server/src/cards/pr08-boseiju-scenarios.ts',",
      '] as const;',
    ].join('\n');
    const bound = bindSources(generator, [
      'packages/server/src/cards/pr12-scenarios.ts',
      'packages/engine/src/cards/overrides/coverage-pr11b.ts',
      'scripts/new-helper.ts',
    ]);
    expect(sourceList(bound)).toEqual([
      'packages/engine/src/cards/overrides/coverage-pr09.ts',
      'packages/engine/src/cards/overrides/coverage-pr11.ts',
      'packages/engine/src/cards/overrides/coverage-pr11b.ts',
      'packages/engine/src/cards/overrides/coverage-pr12.ts',
      'packages/server/src/cards/pr11-scenarios.ts',
      'packages/server/src/cards/pr11b-scenarios.ts',
      'packages/server/src/cards/pr12-scenarios.ts',
      'packages/engine/src/cards/overrides/bug-hunt.ts',
      'packages/server/src/cards/pr08-boseiju-scenarios.ts',
      'scripts/new-helper.ts',
    ]);
    expect(bindSources(bound, ['scripts/new-helper.ts'])).toBe(bound);
  });

  it('registers each scenario file the lab does not read yet, once', () => {
    const source = [
      'export const RUNNER_SCENARIO_FILES: ReadonlyArray<{ name: string; file: CardScenarioFile }> = [',
      '  {',
      "    name: 'a.json',",
      '  },',
      '];',
    ].join('\n');
    const registered = registerScenarioFiles(source, ['a.json', 'b.json']);
    expect(registered.match(/name: 'b\.json'/g)).toHaveLength(1);
    expect(registered).toContain("packages/engine/tests/scenarios/b.json', import.meta.url)");
    expect(registerScenarioFiles(registered, ['a.json', 'b.json'])).toBe(registered);
  });

  it("lists a batch file's cards from their registrations", () => {
    expect(
      batchCards(
        `unimplemented('52241b9c-7a69-4176-9234-8bdab09d8e64', 'Sai, Master Thopterist', []);\n` +
          `defineCard("7060f2c8-fca0-4b7a-bddf-37682f434596", "Whirler Rogue", [], {});`,
      ),
    ).toEqual(['Sai, Master Thopterist', 'Whirler Rogue']);
  });
});
