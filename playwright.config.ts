import { defineConfig } from '@playwright/test';

/** The Card Test Lab backend port. The dev server proxies `/ws`, `/api`, and `/health` here. */
function labPort(name: string, fallback: number): number {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${name}`);
  return port;
}
// Separate lab processes can debug different suites without sharing a live game session.
const LAB_SERVER_PORT = labPort('CARD_TEST_LAB_SERVER_PORT', 3101);
const LAB_WEB_PORT = labPort('CARD_TEST_LAB_WEB_PORT', 5173);
// Permit the installed system browser in managed development environments.
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

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
  use: {
    baseURL: `http://127.0.0.1:${LAB_WEB_PORT}`,
    ...(chromiumExecutable === undefined
      ? {}
      : { launchOptions: { executablePath: chromiumExecutable } }),
    // The player board folds its log into a Game info column, your lands, graveyard and exile into
    // piles, and opponents' zones behind a button, all closed at first; specs read them as part of
    // the board, so every browser starts with them open.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${LAB_WEB_PORT}`,
          localStorage: [
            { name: 'mtg.playerGameInfoOpen', value: 'true' },
            { name: 'mtg.playerPile.lands', value: 'true' },
            { name: 'mtg.playerPile.graveyard', value: 'true' },
            { name: 'mtg.playerPile.exile', value: 'true' },
            { name: 'mtg.playerOpponentZonesOpen', value: 'true' },
          ],
        },
      ],
    },
  },
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
      command: `bun run --cwd apps/web dev --host 127.0.0.1 --port ${LAB_WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${LAB_WEB_PORT}`,
      reuseExistingServer: !process.env['CI'],
      env: { GAME_SERVER_PORT: String(LAB_SERVER_PORT) },
    },
  ],
});
