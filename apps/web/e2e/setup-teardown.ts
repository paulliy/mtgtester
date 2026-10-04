import { rmSync } from 'node:fs';

/**
 * Remove the run directory created by `playwright.setup.config.ts`, which holds the throwaway
 * SQLite database together with its `-wal` and `-shm` sidecars.
 *
 * Playwright stops the web servers *after* global teardown, so on Windows the server can still hold
 * the database open here and the first removal fails. Retry as the Playwright process exits, by
 * which point the server is gone.
 */
export default function removeSetupRunDirectory(): void {
  const directory = process.env['MTG_SETUP_E2E_DIR'];
  if (directory === undefined || directory === '') return;
  if (tryRemove(directory)) return;
  process.once('exit', () => {
    if (!tryRemove(directory)) {
      console.warn(`Left ${directory} in place: the setup database was still locked.`);
    }
  });
}

function tryRemove(directory: string): boolean {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}
