import { defineConfig } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TABLE_HOST_SECRET, TABLE_PORTS, TABLE_TEST_KEY } from './apps/web/e2e/table-env';

/**
 * The table e2e (plan M6 task 5): `serve:table --dev` serving the built table bundle from its own
 * origin, as in production, on the committed Oracle fixture with a fixed test key. There is no
 * Vite dev server: the bundle is built once and every page, socket and request is same-origin.
 *
 * Three table servers run, one per setting the scenarios cannot share: the main table at a
 * lightly scaled relaxed clock, one whose clock is scaled down so a seat times out within
 * seconds, and one whose engine budget is a single event so the first step halts.
 */
function runDirectory(): string {
  const published = process.env['MTG_TABLE_E2E_DIR'];
  if (published !== undefined && published !== '') return published;
  const requested = process.env['TMPDIR'];
  const base =
    requested !== undefined && requested !== '' && existsSync(requested) ? requested : tmpdir();
  const created = mkdtempSync(join(base, 'mtg-table-e2e-'));
  process.env['MTG_TABLE_E2E_DIR'] = created;
  return created;
}

const directory = runDirectory();
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

function server(name: keyof typeof TABLE_PORTS, env: Record<string, string>, build = false) {
  const port = TABLE_PORTS[name];
  const serve = `bun run packages/server/src/cli/serve-table.ts --dev --port ${port} --oracle-fixture packages/server/fixtures/coverage-oracle.json`;
  return {
    // The first server builds the table bundle; the others wait for its health answer first.
    command: build ? `bun run --cwd apps/web build:table && ${serve}` : serve,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      TABLE_DB_PATH: join(directory, `${name}.sqlite`),
      TABLE_WEB_DIR: 'apps/web/dist-table',
      TABLE_HOST_SECRET,
      TABLE_TEST_RNG_KEY: TABLE_TEST_KEY,
      ...env,
    },
  };
}

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: /table-.*\.spec\.ts$/,
  outputDir: 'test-results/table',
  preserveOutput: 'always',
  workers: 1,
  retries: 0,
  timeout: 240_000,
  use: {
    baseURL: `http://127.0.0.1:${TABLE_PORTS.main}`,
    trace: 'on',
    actionTimeout: 15_000,
    ...(chromiumExecutable === undefined
      ? {}
      : { launchOptions: { executablePath: chromiumExecutable } }),
  },
  webServer: [
    server('main', { TABLE_CLOCK: 'relaxed', TABLE_CLOCK_SCALE: '4' }, true),
    server('clock', { TABLE_CLOCK: 'relaxed', TABLE_CLOCK_SCALE: '120' }),
    server('halt', { TABLE_MAX_STEP_WORK: '1' }),
  ],
});
