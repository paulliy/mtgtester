import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// A cold ESLint start (config load, type info) can exceed the 5s default when files run in parallel.
const ESLINT_CHILD_TIMEOUT_MS = 60_000;

const eslint = new ESLint();
const forbidden = [
  ['raw registration', 'registerOverride({});'],
  ['raw mana parsing', "parseManaCost('{2}');"],
  ['inline tokens', "export const token = { typeLine: 'Creature', subtypes: [], colors: [] };"],
  ['executable placeholders', "export const effect = { op: 'noOp' };"],
] as const;

describe('cumulative card authoring restrictions', () => {
  for (const file of ['reviewed-quality-probe.ts', 'quality-probe.ts']) {
    it.each(forbidden)(`rejects %s in ${file}`, async (_label, code) => {
      const results = await eslint.lintText(code, {
        filePath: `packages/engine/src/cards/overrides/${file}`,
      });
      expect(
        results
          .flatMap((result) => result.messages)
          .some((message) => message.ruleId === 'no-restricted-syntax'),
      ).toBe(true);
    });
  }

  it('retains the stricter reviewed ability-envelope rule', async () => {
    const results = await eslint.lintText(
      "export const ability = { kind: 'spell', targets: [], effects: [] };",
      { filePath: 'packages/engine/src/cards/overrides/reviewed-quality-probe.ts' },
    );
    expect(
      results
        .flatMap((result) => result.messages)
        .some(
          (message) =>
            message.ruleId === 'no-restricted-syntax' && message.message.includes('spell()'),
        ),
    ).toBe(true);
  });
});

describe('exact legacy authoring exemptions', () => {
  it('accepts an unchanged legacy override and harmless formatting', async () => {
    const { readFileSync } = await import('node:fs');
    const filePath = 'packages/engine/src/cards/overrides/draconic-destruction.ts';
    const source = readFileSync(filePath, 'utf8');
    for (const code of [
      source,
      source.replace('defineCard(', 'defineCard( /* formatting only */ '),
    ]) {
      const results = await eslint.lintText(code, { filePath });
      expect(
        results
          .flatMap((r) => r.messages)
          .filter((m) => m.ruleId === 'card-authoring/guard-legacy-builders'),
      ).toEqual([]);
    }
  });

  it('a changed legacy card must migrate its raw envelopes and numeric references', async () => {
    const { readFileSync } = await import('node:fs');
    const filePath = 'packages/engine/src/cards/overrides/draconic-destruction.ts';
    const source = readFileSync(filePath, 'utf8').replace(
      "'Primal Might'",
      "'Changed legacy card'",
    );
    const results = await eslint.lintText(source, { filePath });
    expect(
      results
        .flatMap((r) => r.messages)
        .some((m) => m.ruleId === 'card-authoring/guard-legacy-builders'),
    ).toBe(true);
  });

  it('a new definition cannot reuse a raw legacy helper, including through a wrapper', async () => {
    const { readFileSync } = await import('node:fs');
    const { default: tseslint } = await import('typescript-eslint');
    const { collectLegacyScopes } = await import('../../../scripts/eslint/card-authoring.js');
    const filePath = 'packages/engine/src/cards/overrides/draconic-destruction.ts';
    const source = readFileSync(filePath, 'utf8');
    const { bindings } = collectLegacyScopes(tseslint.parser.parseForESLint(source).ast);
    const helper = [...bindings.keys()][0];
    expect(helper).toBeDefined();
    const code =
      source +
      `\nconst legacyWrapper = ${helper};\ndefineCard('new', 'New card', [], {spellAbility: legacyWrapper});\n`;
    const results = await eslint.lintText(code, { filePath });
    expect(
      results
        .flatMap((r) => r.messages)
        .some(
          (m) =>
            m.ruleId === 'card-authoring/guard-legacy-builders' &&
            m.message.includes('legacy ability helper'),
        ),
    ).toBe(true);
  });

  it.each([
    "export const ability = {kind: 'spell', targets: [], effects: []};",
    "export const effect = {op: 'destroy', target: 0};",
  ])('new overrides receive the stricter builders rule: %s', async (code) => {
    const results = await eslint.lintText(code, {
      filePath: 'packages/engine/src/cards/overrides/quality-probe.ts',
    });
    expect(
      results
        .flatMap((r) => r.messages)
        .some((m) => m.ruleId === 'card-authoring/guard-legacy-builders'),
    ).toBe(true);
  });
});

it('keeps the legacy exemption inventory exact, with no duplicate or stale entries', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { default: tseslint } = await import('typescript-eslint');
  const { collectLegacyScopes } = await import('../../../scripts/eslint/card-authoring.js');
  const directory = 'packages/engine/src/cards/overrides';
  const current: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.ts') || ['index.ts', 'snapshot.ts'].includes(name)) continue;
    const file = `${directory}/${name}`;
    const ast = tseslint.parser.parseForESLint(readFileSync(file, 'utf8')).ast;
    current.push(...[...collectLegacyScopes(ast).scopes.keys()].map((hash) => `${file}:${hash}`));
  }
  const baseline = JSON.parse(
    readFileSync('packages/engine/tests/fixtures/legacy-authoring-exemptions.json', 'utf8'),
  ) as { schemaVersion: number; scopes: { file: string; sha256: string }[] };
  expect(baseline.schemaVersion).toBe(1);
  const expected = baseline.scopes.map((scope) => `${scope.file}:${scope.sha256}`);
  expect(new Set(expected).size).toBe(expected.length);
  expect(current.sort()).toEqual(expected.sort());
});

it(
  'resolves authorized file identities when ESLint runs from a nested directory',
  async () => {
    const { execFileSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const output = execFileSync(
      process.execPath,
      [
        resolve('node_modules/eslint/bin/eslint.js'),
        resolve('packages/engine/src/cards/overrides/draconic-destruction.ts'),
        '--format',
        'json',
      ],
      { cwd: resolve('packages/engine'), encoding: 'utf8' },
    );
    const results = JSON.parse(output) as { messages: { ruleId: string }[] }[];
    expect(
      results
        .flatMap((result) => result.messages)
        .filter((message) => message.ruleId === 'card-authoring/guard-legacy-builders'),
    ).toEqual([]);
  },
  ESLINT_CHILD_TIMEOUT_MS,
);
