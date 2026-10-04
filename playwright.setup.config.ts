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

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: 'player-setup.spec.ts',
  globalTeardown: './apps/web/e2e/setup-teardown.ts',
  workers: 1,
  timeout: 120_000,
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: [
    {
      command: `bun run packages/server/src/cli/serve.ts --port ${port} --db-path "${dbPath}"`,
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
