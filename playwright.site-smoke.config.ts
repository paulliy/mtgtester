import { defineConfig, devices } from '@playwright/test';

/**
 * The site smoke test in one browser engine: `SITE_BROWSER=chromium` (the default), `firefox` or
 * `webkit`. It starts a game in the worker, which is the part most likely to differ between
 * engines. `playwright.site.config.ts` runs the rest of the site suite in Chromium.
 */
const port = 3132;
const browser =
  process.env['SITE_BROWSER'] === 'firefox' || process.env['SITE_BROWSER'] === 'webkit'
    ? process.env['SITE_BROWSER']
    : 'chromium';
const device = { chromium: 'Desktop Chrome', firefox: 'Desktop Firefox', webkit: 'Desktop Safari' };
// Permit the installed system browser in managed development environments, as the lab config does.
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: './apps/web/e2e/site',
  testMatch: /smoke\.spec\.ts$/,
  outputDir: `test-results/site-${browser}`,
  workers: 1,
  timeout: 240_000,
  use: {
    ...devices[device[browser]],
    ...(browser === 'chromium' && chromiumExecutable !== undefined
      ? { launchOptions: { executablePath: chromiumExecutable } }
      : {}),
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
