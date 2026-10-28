import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cardGateEntries,
  checkSuiteIntegrity,
  globMatches,
  parsePlaywrightConfig,
  parseVitestConfig,
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

const gate = (...entries: string[]) =>
  JSON.stringify({
    scripts: { 'test:card-gate': `bun run audit:card-ir && vitest run ${entries.join(' ')}` },
  });

/** A small repository whose layout mirrors the real one. */
function repo(extra: Record<string, string> = {}, files: string[] = []) {
  const contents: Record<string, string> = {
    'vitest.config.ts': VITEST,
    'playwright.config.ts': PLAYWRIGHT,
    'playwright.setup.config.ts': PLAYWRIGHT_SETUP,
    'package.json': gate('packages/engine/tests/a.test.ts', 'packages/server/src/cards'),
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
  it('lists every filter after `vitest run`', () => {
    expect(cardGateEntries(gate('a/b.test.ts', 'c/d'))).toEqual(['a/b.test.ts', 'c/d']);
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

  it('fires on a card-gate entry that matches no file', () => {
    const { errors } = checkSuiteIntegrity(
      repo({
        'package.json': gate(
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
      repo({ 'package.json': gate('apps/web/e2e/lab.spec.ts') }),
    );
    expect(errors).toEqual([expect.stringContaining('`apps/web/e2e/lab.spec.ts`')]);
  });

  it('fires on a Vite config that hides a Vitest block', () => {
    const { errors } = checkSuiteIntegrity(
      repo({ 'apps/web/vite.config.ts': 'export default { test: { include: [] } };' }),
    );
    expect(errors).toEqual([expect.stringContaining('apps/web/vite.config.ts: defines a `test`')]);
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
    expect(result.runners).toEqual(
      expect.arrayContaining(['vitest.config.ts', 'playwright.config.ts']),
    );
  });
});
