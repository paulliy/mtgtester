/** The authoring commands' pure parts (ADR 0033 decision 1, plan phase 2). */
import { describe, expect, it } from 'vitest';
import { lineDiff, snapshotChange } from '../../../../scripts/cards/card-check';
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
