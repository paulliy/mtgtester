import { defineConfig } from '@playwright/test';

/**
 * Single player in the browser (ADR 0053): the bundled game worker in headless Chromium, served
 * by `scripts/browser-worker-harness.ts` with the site card files built from the Oracle fixture.
 * No game server runs.
 */
const port = 3121;
// Permit the installed system browser in managed development environments, as the lab config does.
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: /browser-worker\.spec\.ts$/,
  // Leave the lab and setup suites' traces in test-results/ alone.
  outputDir: 'test-results/browser',
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    ...(chromiumExecutable === undefined
      ? {}
      : { launchOptions: { executablePath: chromiumExecutable } }),
  },
  webServer: {
    command: `bun run scripts/browser-worker-harness.ts --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
