import { readFileSync } from 'node:fs';
import { PUMP_UNIT_TEST, strictPumpErrors } from '../../../../scripts/contracts/strict-pump';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ABILITY_SOURCE,
  MANIFEST,
  SLUG_FILE,
  collectCardNames,
} from '../../../../scripts/contracts/card-names';
import {
  cardNameSlugs,
  checkCardNamedOps,
  checkNotExecutableInCi,
  effectOps,
  notExecutableInCiIds,
  resolveBase,
  slugTable,
  type SlugFile,
} from '../../../../scripts/contracts/ratchets';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const source = (...ops: string[]) =>
  `export type Effect =\n${ops.map((op) => `  | { op: '${op}'; target: string }`).join('\n')};`;

const slugs = slugTable(["Angel's Grace", 'Kambal, Consul of Allocation', 'Master of Ceremonies']);

describe('card-name slugs', () => {
  it('camel-cases names, dropping the possessive and the legend suffix', () => {
    expect(cardNameSlugs("Angel's Grace")).toEqual(
      expect.arrayContaining(['angelGrace', 'angelsGrace']),
    );
    expect(cardNameSlugs('Kambal, Consul of Allocation')).toEqual(
      expect.arrayContaining(['kambal', 'kambalConsulOfAllocation']),
    );
    expect(cardNameSlugs('Master of Ceremonies')).toEqual(['masterOfCeremonies']);
  });

  it('slugs every face of a double-faced card', () => {
    expect(cardNameSlugs('Sejiri Shelter // Sejiri Glacier')).toEqual(
      expect.arrayContaining(['sejiriShelter', 'sejiriGlacier']),
    );
  });
});

describe('Effect op discovery', () => {
  it('reads the op of every member of the union', () => {
    expect(effectOps('ability.ts', source('draw', 'angelGrace'))).toEqual(['draw', 'angelGrace']);
  });

  it('refuses a member it cannot read rather than skipping it', () => {
    expect(() =>
      effectOps('ability.ts', "export type Effect = { op: 'a' } | OtherEffect;"),
    ).toThrow(/OtherEffect/);
    expect(() => effectOps('ability.ts', 'export type Other = {};')).toThrow(/no `Effect`/);
  });

  it('finds the real union', () => {
    const ops = effectOps(ABILITY_SOURCE, read(ABILITY_SOURCE));
    expect(ops.length).toBeGreaterThan(300);
    expect(ops).toEqual(expect.arrayContaining(['dealDamage', 'angelGrace']));
    expect(new Set(ops).size).toBe(ops.length);
  });
});

describe('ratchet 1: card-named ops may not grow', () => {
  const base = ['draw', 'angelGrace'];

  it('passes when nothing is added, and when a card-named op is removed', () => {
    expect(checkCardNamedOps({ baseOps: base, headOps: base, slugs }).errors).toEqual([]);
    expect(checkCardNamedOps({ baseOps: base, headOps: ['draw'], slugs })).toMatchObject({
      errors: [],
      cardNamed: [],
    });
  });

  it('fires on a new op equal to a card-name slug', () => {
    const result = checkCardNamedOps({
      baseOps: base,
      headOps: [...base, 'masterOfCeremonies'],
      slugs,
    });
    expect(result.errors).toEqual([expect.stringContaining('`masterOfCeremonies`')]);
    expect(result.errors[0]).toContain('"Master of Ceremonies"');
  });

  it('does not fail on a card-named op that the base already had', () => {
    expect(checkCardNamedOps({ baseOps: ['kambal'], headOps: ['kambal'], slugs })).toMatchObject({
      errors: [],
      cardNamed: ['kambal'],
    });
  });

  it('warns, without failing, on a new op containing And or Then', () => {
    const result = checkCardNamedOps({
      baseOps: base,
      headOps: [...base, 'sacrificeThenDraw', 'drawAndDiscard', 'sacrificeAndroid', 'thenReturn'],
      slugs,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('`sacrificeThenDraw`'),
      expect.stringContaining('`drawAndDiscard`'),
    ]);
  });

  it('does not warn about an existing And/Then op', () => {
    const result = checkCardNamedOps({
      baseOps: ['drawAndDiscard'],
      headOps: ['drawAndDiscard'],
      slugs,
    });
    expect(result.warnings).toEqual([]);
  });

  it('finds the card-named ops on this repository', () => {
    const committed = JSON.parse(read(SLUG_FILE)) as SlugFile;
    const ops = effectOps(ABILITY_SOURCE, read(ABILITY_SOURCE));
    const result = checkCardNamedOps({ baseOps: ops, headOps: ops, slugs: committed.slugs });
    expect(result.cardNamed).toEqual(expect.arrayContaining(['angelGrace', 'masterOfCeremonies']));
  });

  it('covers the cards in the pinned fixtures', () => {
    const committed = JSON.parse(read(SLUG_FILE)) as SlugFile;
    expect(Object.keys(committed.slugs).length).toBeGreaterThan(1000);
    expect(collectCardNames(fileURLToPath(root)).has("Angel's Grace")).toBe(true);
  });
});

describe('ratchet 2: notExecutableInCi IDs may not grow', () => {
  const manifest = (clause: Record<string, unknown>) =>
    JSON.stringify({ schemaVersion: 1, cards: { 'oracle-1': { name: 'A', clauses: [clause] } } });

  it('reads both marker forms', () => {
    expect(
      notExecutableInCiIds(manifest({ engineTestIds: ['a', 'b'], notExecutableInCi: ['b'] })),
    ).toEqual(new Set(['oracle-1::b']));
    expect(
      notExecutableInCiIds(
        manifest({ engineTestIds: ['a', { id: 'c', notExecutableInCi: true }] }),
      ),
    ).toEqual(new Set(['oracle-1::c']));
  });

  it('reads a card-level engineTestIds entry marked notExecutableInCi', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      cards: {
        'oracle-1': {
          name: 'A',
          engineTestIds: ['a', { id: 'b', notExecutableInCi: true }],
          clauses: [],
        },
      },
    });
    expect(notExecutableInCiIds(text)).toEqual(new Set(['oracle-1::b']));
  });

  it('passes with no new marks, and fires on a newly marked ID', () => {
    const before = manifest({ engineTestIds: ['a', 'b'], notExecutableInCi: ['b'] });
    expect(checkNotExecutableInCi({ baseManifest: before, headManifest: before }).errors).toEqual(
      [],
    );
    const after = manifest({ engineTestIds: ['a', 'b'], notExecutableInCi: ['a', 'b'] });
    expect(checkNotExecutableInCi({ baseManifest: before, headManifest: after }).errors).toEqual([
      expect.stringContaining('`oracle-1::a`'),
    ]);
  });

  it('allows the list to shrink', () => {
    const before = manifest({ engineTestIds: ['a', 'b'], notExecutableInCi: ['a', 'b'] });
    const after = manifest({ engineTestIds: ['a', 'b'], notExecutableInCi: ['b'] });
    expect(checkNotExecutableInCi({ baseManifest: before, headManifest: after })).toMatchObject({
      errors: [],
      count: 1,
    });
  });

  it('counts every mark as new when the base has no manifest', () => {
    const head = manifest({ engineTestIds: ['a'], notExecutableInCi: ['a'] });
    expect(
      checkNotExecutableInCi({ baseManifest: undefined, headManifest: head }).errors,
    ).toHaveLength(1);
  });

  it('is zero in the committed manifest today, and the check passes', () => {
    const text = read(MANIFEST);
    expect(checkNotExecutableInCi({ baseManifest: text, headManifest: text })).toEqual({
      errors: [],
      count: 0,
    });
  });
});

describe('base commit resolution (the ci.yml push fallback)', () => {
  const sha = 'a'.repeat(40);
  const parent = 'b'.repeat(40);
  const git = (known: string[], first: string | undefined) => ({
    hasCommit: (value: string) => known.includes(value),
    firstParent: () => first,
  });

  it('uses the supplied base when it names a commit', () => {
    expect(resolveBase(sha, git([sha], parent))).toEqual({ kind: 'base', sha });
  });

  it.each([undefined, '', '0'.repeat(40), sha])(
    "falls back to HEAD's first parent for %j when the base is empty, all zeros or unknown",
    (value) => {
      expect(resolveBase(value, git([], parent))).toMatchObject({ kind: 'base', sha: parent });
    },
  );

  it('skips the comparison when there is no parent either', () => {
    expect(resolveBase(undefined, git([], undefined))).toMatchObject({ kind: 'none' });
  });
});

describe('strict pump() calls in changed tests', () => {
  const file = (head: string, base?: string) => [
    { path: 'packages/engine/tests/x.test.ts', head, base },
  ];

  it('accepts a new call answered by a script or marked strict', () => {
    expect(
      strictPumpErrors(
        file(`pump(gen, script([{ prompt: 'Scry', choose: 'top' }]));
pump(gen, answer, { strict: true });
pumpStrict(gen);`),
      ),
    ).toEqual([]);
  });

  it('fires on a new guessing call and on a () => ({ index: 0 }) answer', () => {
    expect(
      strictPumpErrors(file(`pump(gen);\npump(gen, () => ({ index: 0, targets: new Map() }));`)),
    ).toEqual([
      expect.stringContaining('x.test.ts:1: a new or changed pump() call'),
      expect.stringContaining('x.test.ts:2: a new or changed pump() call'),
      expect.stringContaining('x.test.ts:2: () => ({ index: 0 }) guesses'),
    ]);
  });

  it('leaves existing calls alone, rewrapped or not, and catches a changed one', () => {
    const base = 'pump(gen, (d) => answer(d, 1));\npump(other);';
    expect(
      strictPumpErrors(file('pump(\n  gen,\n  (d) => answer(d, 1),\n);\npump(other);', base)),
    ).toEqual([]);
    expect(strictPumpErrors(file('pump(gen, (d) => answer(d, 2));\npump(other);', base))).toEqual([
      expect.stringContaining('x.test.ts:1:'),
    ]);
    // A second copy of an existing call is new.
    expect(strictPumpErrors(file('pump(other);\npump(other);', 'pump(other);'))).toHaveLength(1);
  });

  it('exempts only the unit test of pump itself, which pins the non-strict default', () => {
    expect(
      strictPumpErrors([{ path: PUMP_UNIT_TEST, head: 'pump(gen);', base: undefined }]),
    ).toEqual([]);
    expect(
      strictPumpErrors([
        { path: 'packages/engine/tests/other/script.test.ts', head: 'pump(gen);', base: undefined },
      ]),
    ).toHaveLength(1);
  });

  it('reports a new call at its own line when it repeats an old call that moved', () => {
    const base = 'it("a", () => {\n  pump(gen);\n});\n';
    const head =
      'it("new", () => {\n  pump(gen);\n  const extra = 1;\n});\nit("a", () => {\n  pump(gen);\n});\n';
    expect(strictPumpErrors(file(head, base))).toEqual([expect.stringContaining('x.test.ts:2:')]);
  });
});
