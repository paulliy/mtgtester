import { defineConfig } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 3102;

/**
 * One throwaway directory per run. The SQLite file and its `-wal`/`-shm` sidecars all live inside
 * it, so the global teardown removes the whole set by removing the directory — a bare
 * `join(tmpdir(), ...sqlite)` path left the two sidecars behind on every run.
 *
 * TMPDIR wins when the environment provides a usable one (the Windows scratch mount), otherwise the
 * OS temp directory. Playwright re-loads this config in worker processes, so the first process
 * publishes its choice and the rest reuse it rather than each creating an orphan directory.
 */
function runDirectory(): string {
  const published = process.env['MTG_SETUP_E2E_DIR'];
  if (published !== undefined && published !== '') return published;
  const requested = process.env['TMPDIR'];
  const base =
    requested !== undefined && requested !== '' && existsSync(requested) ? requested : tmpdir();
  const created = mkdtempSync(join(base, 'mtg-phase91-e2e-'));
  process.env['MTG_SETUP_E2E_DIR'] = created;
  return created;
}

const dbPath = join(runDirectory(), 'setup.sqlite');
// Permit the installed system browser in managed development environments, as the lab config does.
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: /player-(setup|game)\.spec\.ts$/,
  // Playwright empties its output directory when a run starts. CI runs this suite after the Card
  // Test Lab, whose traces in `test-results/` are retained viewer evidence, so this run writes to
  // a subdirectory of its own instead of wiping them.
  outputDir: 'test-results/setup',
  globalTeardown: './apps/web/e2e/setup-teardown.ts',
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // CI's "Require viewer traces" step needs a trace.zip under test-results/ when only this suite
    // runs (the `ci:setup` label), and the traces are viewer evidence as for the lab specs.
    trace: 'on',
    ...(chromiumExecutable === undefined
      ? {}
      : { launchOptions: { executablePath: chromiumExecutable } }),
    // Every browser starts as a returning visitor: the New game opening ("Where to?") counts as
    // seen, so specs land on the setup panel, and the board's log, piles and opponents' zones are
    // open because specs read them as part of the board. This lives here rather than in a
    // `beforeEach` of `setup-test.ts`: a hook in a shared module registers only for the first spec
    // file that loads it in a worker, so the next file's first test started without it.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:5173',
          localStorage: [
            { name: 'decktank.opened', value: 'true' },
            { name: 'mtg.playerGameInfoOpen', value: 'true' },
            { name: 'mtg.playerOpponentZonesOpen', value: 'true' },
            { name: 'mtg.playerOpponentLandsOpen', value: 'true' },
            { name: 'mtg.playerPile.lands', value: 'true' },
            { name: 'mtg.playerPile.graveyard', value: 'true' },
            { name: 'mtg.playerPile.exile', value: 'true' },
          ],
        },
      ],
    },
  },
  webServer: [
    {
      // The committed Oracle fixture, not the gitignored Scryfall bulk file, so this runs in CI.
      command: `bun run packages/server/src/cli/serve.ts --port ${port} --db-path "${dbPath}" --oracle-fixture packages/server/fixtures/coverage-oracle.json`,
      url: `http://127.0.0.1:${port}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'bun run --cwd apps/web dev --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      env: { GAME_SERVER_PORT: String(port) },
    },
  ],
});
