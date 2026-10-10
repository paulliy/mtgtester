import { defineConfig } from '@playwright/test';

/** The Card Test Lab backend port. The dev server proxies `/ws`, `/api`, and `/health` here. */
const LAB_SERVER_PORT = 3101;

export default defineConfig({
  testDir: './apps/web/e2e',
  // These run against their own DB-backed backend via playwright.setup.config.ts.
  testIgnore: /player-(setup|game)\.spec\.ts$/,
  fullyParallel: true,
  retries: 0,
  // The lab backend holds a single live session, so specs that share it must not overlap in time.
  // Parallel workers let one spec's game replace another's and leave it stuck on /card-test-lab.
  workers: 1,
  // Card Test Lab traces are viewer-verification evidence (docs/guides/card-modeling-and-testing.md):
  // they must survive passing runs, not just failures.
  preserveOutput: 'always',
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: [
    {
      // Offline lab backend: empty pool, no database, no bulk Scryfall file. The Card Test Lab
      // spec exercises this real server over the production WebSocket protocol; the audit smoke
      // spec mocks its own transport and is unaffected by which backend is up.
      command: `bun run packages/server/src/cli/serve.ts --card-test-lab --port ${LAB_SERVER_PORT} --no-db`,
      url: `http://127.0.0.1:${LAB_SERVER_PORT}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: 'bun run --cwd apps/web dev --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env['CI'],
      env: { GAME_SERVER_PORT: String(LAB_SERVER_PORT) },
    },
  ],
});
