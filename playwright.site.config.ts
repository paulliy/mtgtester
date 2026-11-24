import { defineConfig, devices } from '@playwright/test';

/**
 * The public site as it ships (ADR 0053, plan section 8): the local-games build served by
 * `scripts/site-harness.ts` with the site card files from the Oracle fixture, and no game server.
 * Chromium plays a solo game and a watch game and follows the links between single player and
 * the tables. The smoke test belongs to `playwright.site-smoke.config.ts`, which runs it in
 * Chromium, Firefox and WebKit.
 */
const port = 3131;
// Permit the installed system browser in managed development environments, as the lab config does.
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: './apps/web/e2e/site',
  testIgnore: /smoke\.spec\.ts$/,
  outputDir: 'test-results/site',
  workers: 1,
  timeout: 240_000,
  use: {
    ...devices['Desktop Chrome'],
    ...(chromiumExecutable === undefined
      ? {}
      : { launchOptions: { executablePath: chromiumExecutable } }),
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bun run scripts/site-harness.ts --port ${port}`,
    url: `http://127.0.0.1:${port}/cards/manifest.json`,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
});
