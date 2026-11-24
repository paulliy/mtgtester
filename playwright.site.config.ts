import { defineConfig, devices } from '@playwright/test';

/**
 * The public site as it ships (ADR 0053, plan section 8): the local-games build served by
 * `scripts/site-harness.ts` with the site card files from the Oracle fixture, and no game server.
 * Chromium plays a solo game and a watch game and follows the links between single player and
 * the tables; Firefox and WebKit run the smoke test, which starts a game in the worker.
 */
const port = 3131;
// Permit the installed system browser in managed development environments, as the lab config does.
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
// `SITE_BROWSERS=chromium` runs Chromium alone where the other browsers are not installed.
const browsers = (process.env['SITE_BROWSERS'] ?? 'chromium,firefox,webkit').split(',');

export default defineConfig({
  testDir: './apps/web/e2e/site',
  outputDir: 'test-results/site',
  workers: 1,
  timeout: 240_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumExecutable === undefined
          ? {}
          : { launchOptions: { executablePath: chromiumExecutable } }),
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testMatch: /smoke\.spec\.ts$/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /smoke\.spec\.ts$/ },
  ].filter((project) => browsers.includes(project.name)),
  webServer: {
    command: `bun run scripts/site-harness.ts --port ${port}`,
    url: `http://127.0.0.1:${port}/cards/manifest.json`,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
});
