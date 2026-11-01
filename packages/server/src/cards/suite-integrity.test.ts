import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cardGateEntries,
  checkSuiteIntegrity,
  cardGateFiles,
  countPlaywrightList,
  countVitestList,
  discoverRunners,
  emptySuiteErrors,
  globMatches,
  suiteRequirements,
  parsePlaywrightConfig,
  parseVitestConfig,
  rerunsOf,
} from '../../../../scripts/contracts/suite-integrity';

const VITEST = `import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/e2e/**'],
  },
});`;

const PLAYWRIGHT = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './apps/web/e2e',
  testIgnore: /player-(setup|game)\\.spec\\.ts$/,
});`;

const PLAYWRIGHT_SETUP = `import { defineConfig } from '@playwright/test';
const dir = String(Math.random());
export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: /player-(setup|game)\\.spec\\.ts$/,
  workers: 1,
});`;

const gate = (...entries: string[]) => `# the card gate\n\n${entries.join('\n')}\n`;

/** A small repository whose layout mirrors the real one. */
function repo(extra: Record<string, string> = {}, files: string[] = []) {
  const contents: Record<string, string> = {
    'vitest.config.ts': VITEST,
    'playwright.config.ts': PLAYWRIGHT,
    'playwright.setup.config.ts': PLAYWRIGHT_SETUP,
    'scripts/card-gate.txt': gate('packages/engine/tests/a.test.ts', 'packages/server/src/cards'),
    ...extra,
  };
  const tracked = [
    ...Object.keys(contents),
    'packages/engine/tests/a.test.ts',
    'packages/server/src/cards/b.test.ts',
    'apps/web/e2e/lab.spec.ts',
    'apps/web/e2e/player-game.spec.ts',
    ...files,
  ];
  return {
    files: [...new Set(tracked)],
    read: (path: string) => {
      const text = contents[path];
      if (text === undefined) throw new Error(`unexpected read of ${path}`);
      return text;
    },
  };
}

describe('glob matching for runner configs', () => {
  it.each([
    ['packages/**/*.{test,spec}.ts', 'packages/engine/tests/a.test.ts', true],
    ['packages/**/*.{test,spec}.ts', 'packages/a.spec.ts', true],
    ['packages/**/*.{test,spec}.ts', 'apps/web/a.test.ts', false],
    ['packages/**/*.{test,spec}.ts', 'packages/engine/tests/a.test.js', false],
    ['**/e2e/**', 'apps/web/e2e/x.spec.ts', true],
    ['**/e2e/**', 'apps/web/src/x.spec.ts', false],
    ['**/*.@(spec|test).?(c|m)[jt]s?(x)', 'a/b/c.spec.ts', true],
    ['**/*.@(spec|test).?(c|m)[jt]s?(x)', 'c.test.mjs', true],
    ['**/*.@(spec|test).?(c|m)[jt]s?(x)', 'c.test.tsx', true],
    ['**/*.@(spec|test).?(c|m)[jt]s?(x)', 'c.tests.ts', false],
  ])('%s against %s is %s', (glob, path, expected) => {
    expect(globMatches(glob, path)).toBe(expected);
  });
});

describe('reading runner configs as source', () => {
  it('reads Vitest include and exclude', () => {
    const runner = parseVitestConfig('vitest.config.ts', VITEST);
    expect(runner.include).toEqual(['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts']);
    expect(runner.exclude).toEqual(['**/node_modules/**', '**/e2e/**']);
  });

  it('reads Playwright testDir, testMatch and testIgnore without evaluating the config', () => {
    const ignoring = parsePlaywrightConfig('playwright.config.ts', PLAYWRIGHT);
    expect(ignoring.testDir).toBe('apps/web/e2e');
    expect(ignoring.testIgnore).toHaveLength(1);
    const matching = parsePlaywrightConfig('playwright.setup.config.ts', PLAYWRIGHT_SETUP);
    expect(matching.testMatch).toHaveLength(1);
  });

  it('refuses a config it cannot read rather than guessing', () => {
    expect(() =>
      parseVitestConfig(
        'vitest.config.ts',
        'export default { test: { include: patterns, exclude: [] } };',
      ),
    ).toThrow(/test\.include/);
    expect(() =>
      parsePlaywrightConfig('playwright.config.ts', 'export default { projects: [] };'),
    ).toThrow(/projects/);
  });
});

describe('card-gate entries', () => {
  it('reads every line that is not blank or a comment', () => {
    expect(cardGateEntries(gate('a/b.test.ts', 'c/d'))).toEqual(['a/b.test.ts', 'c/d']);
  });

  it('runs every Vitest test file whose path contains an entry, and no e2e spec', () => {
    const input = repo();
    const { runners } = discoverRunners(input);
    expect(
      cardGateFiles(['packages/server/src/cards', 'apps/web/e2e'], input.files, runners),
    ).toEqual(['packages/server/src/cards/b.test.ts']);
  });
});

describe('suite integrity', () => {
  it('accepts a repository where each test file has exactly one runner', () => {
    expect(checkSuiteIntegrity(repo()).errors).toEqual([]);
  });

  it('fires on a test file no runner claims', () => {
    // `scripts/` is outside the Vitest include, and Playwright only looks in apps/web/e2e.
    const { errors } = checkSuiteIntegrity(repo({}, ['scripts/orphan.test.ts']));
    expect(errors).toEqual([expect.stringContaining('scripts/orphan.test.ts: not claimed')]);
  });

  it('fires on a spec file inside e2e that Vitest and Playwright both skip', () => {
    // Both Playwright configs would claim it, so it is not an orphan; excluding it from both is.
    const { errors } = checkSuiteIntegrity(
      repo(
        {
          'playwright.config.ts': PLAYWRIGHT.replace(
            'testIgnore: /player',
            'testIgnore: /lab|player',
          ),
        },
        ['apps/web/e2e/lab-two.spec.ts'],
      ),
    );
    expect(errors.join('\n')).toContain('apps/web/e2e/lab-two.spec.ts: not claimed');
  });

  it('fires on a test file two runners claim', () => {
    const second = `export default { test: { include: ['packages/server/**/*.test.ts'], exclude: [] } };`;
    const { errors } = checkSuiteIntegrity(repo({ 'vitest.integration.config.ts': second }));
    expect(errors).toEqual([
      expect.stringContaining(
        'packages/server/src/cards/b.test.ts: claimed by more than one runner (vitest.config.ts, vitest.integration.config.ts)',
      ),
    ]);
  });

  it('skips a config that reruns another, and fires when the one it names is missing', () => {
    const rerun = `// suite-integrity: reruns vitest.config.ts
import root from './vitest.config';
export default mergeConfig(root, defineConfig({ test: { setupFiles: ['setup.ts'] } }));`;
    expect(checkSuiteIntegrity(repo({ 'vitest.mutation.config.ts': rerun })).errors).toEqual([]);
    const orphan = rerun.replace('reruns vitest.config.ts', 'reruns vitest.gone.config.ts');
    expect(checkSuiteIntegrity(repo({ 'vitest.mutation.config.ts': orphan })).errors).toEqual([
      'vitest.mutation.config.ts: reruns vitest.gone.config.ts, which is not a tracked file',
    ]);
    // The marker must be a whole comment line.
    expect(rerunsOf(`const note = '// suite-integrity: reruns vitest.config.ts';`)).toBeNull();
  });

  it('fires on a card-gate entry that matches no file', () => {
    const { errors } = checkSuiteIntegrity(
      repo({
        'scripts/card-gate.txt': gate(
          'packages/engine/tests/a.test.ts',
          'packages/engine/tests/gone.test.ts',
        ),
      }),
    );
    expect(errors).toEqual([expect.stringContaining('`packages/engine/tests/gone.test.ts`')]);
  });

  it('counts a card-gate entry as a match only for a file Vitest runs', () => {
    // The e2e spec exists and is tracked, but the gate hands paths to Vitest, which excludes it.
    const { errors } = checkSuiteIntegrity(
      repo({ 'scripts/card-gate.txt': gate('apps/web/e2e/lab.spec.ts') }),
    );
    expect(errors).toEqual([expect.stringContaining('`apps/web/e2e/lab.spec.ts`')]);
  });

  it('fires on a Vite config that hides a Vitest block', () => {
    const { errors } = checkSuiteIntegrity(
      repo({ 'apps/web/vite.config.ts': 'export default { test: { include: [] } };' }),
    );
    expect(errors).toEqual([expect.stringContaining('apps/web/vite.config.ts: defines a `test`')]);
  });

  it('reads a Vite config written as a function of the mode', () => {
    const { errors } = checkSuiteIntegrity(
      repo({
        'apps/web/vite.config.ts':
          'export default defineConfig(({ mode }) => ({ test: { include: [] } }));',
      }),
    );
    expect(errors).toEqual([expect.stringContaining('apps/web/vite.config.ts: defines a `test`')]);
  });
});

describe('suite collection', () => {
  const { runners } = discoverRunners(repo());
  const files = repo().files;
  const collected = (vitest: Record<string, number>, playwright: Record<string, number>) =>
    new Map([
      ['vitest.config.ts', new Map(Object.entries(vitest))],
      ['playwright.config.ts', new Map(Object.entries(playwright))],
      ['playwright.setup.config.ts', new Map([['apps/web/e2e/player-game.spec.ts', 1]])],
    ]);

  it('accepts files that each collect a test from their own runner', () => {
    const result = emptySuiteErrors(
      files,
      runners,
      collected(
        { 'packages/engine/tests/a.test.ts': 2, 'packages/server/src/cards/b.test.ts': 1 },
        { 'apps/web/e2e/lab.spec.ts': 4 },
      ),
    );
    expect(result).toEqual({ errors: [], excused: [] });
  });

  it('fires on a file its runner collects nothing from, even if another runner lists it', () => {
    const result = emptySuiteErrors(
      files,
      runners,
      collected({ 'packages/engine/tests/a.test.ts': 2, 'apps/web/e2e/lab.spec.ts': 1 }, {}),
    );
    expect(result.errors).toEqual([
      'packages/server/src/cards/b.test.ts: vitest.config.ts collects no test from it',
      'apps/web/e2e/lab.spec.ts: playwright.config.ts collects no test from it',
    ]);
  });

  it('excuses an empty file only while the untracked data it declares is missing', () => {
    const counts = collected(
      { 'packages/engine/tests/a.test.ts': 2 },
      { 'apps/web/e2e/lab.spec.ts': 1 },
    );
    const missing = (file: string) =>
      file === 'packages/server/src/cards/b.test.ts' ? 'data/bulk.json' : null;
    expect(emptySuiteErrors(files, runners, counts, missing)).toEqual({
      errors: [],
      excused: ['packages/server/src/cards/b.test.ts: needs data/bulk.json, which is not present'],
    });
    expect(emptySuiteErrors(files, runners, counts).errors).toHaveLength(1);
  });

  it('reads the requirement marker only as a whole comment line', () => {
    expect(
      suiteRequirements(
        '// suite-requires: data/a.json\nconst x = 1; // suite-requires: data/b.json\n// suite-requires: data/c.json',
      ),
    ).toEqual(['data/a.json', 'data/c.json']);
  });

  it("counts tests per file from both runners' listings", () => {
    expect(
      countVitestList(
        JSON.stringify([
          { name: 'a > one', file: '/repo/packages/x.test.ts' },
          { name: 'a > two', file: '/repo/packages/x.test.ts' },
          { name: 'b', file: '/repo/packages/y.test.ts' },
        ]),
        '/repo',
      ),
    ).toEqual(
      new Map([
        ['packages/x.test.ts', 2],
        ['packages/y.test.ts', 1],
      ]),
    );
    expect(
      countPlaywrightList(
        JSON.stringify({
          suites: [
            {
              specs: [{ file: 'lab.spec.ts', tests: [{}, {}] }],
              suites: [{ specs: [{ file: 'lab.spec.ts', tests: [{}] }] }],
            },
          ],
        }),
        'apps/web/e2e',
      ),
    ).toEqual(new Map([['apps/web/e2e/lab.spec.ts', 3]]));
  });
});

describe('this repository', () => {
  it('has every tracked test file claimed by exactly one runner and every card-gate entry live', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0')
      .filter((file) => file !== '');
    const root = new URL('../../../../', import.meta.url);
    const result = checkSuiteIntegrity({
      files,
      read: (path) => readFileSync(new URL(path, root), 'utf8'),
    });
    expect(result.errors).toEqual([]);
    expect(result.cardGateEntries).toBeGreaterThan(0);
    // The gate runs the committed list, not a file list kept in package.json.
    const scripts = (
      JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['test:card-gate']).toMatch(/bun run scripts\/card-gate\.ts$/);
    expect(result.runners).toEqual(
      expect.arrayContaining(['vitest.config.ts', 'playwright.config.ts']),
    );
  });
});
