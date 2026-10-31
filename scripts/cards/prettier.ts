import { execFileSync } from 'node:child_process';

/**
 * `prettier --write` through the running Bun binary (`bun x`), which launches on Windows where
 * `npx` is `npx.cmd` and cannot be spawned without a shell. Its errors show.
 */
export function runPrettier(paths: readonly string[]): void {
  if (paths.length === 0) return;
  execFileSync(process.execPath, ['x', 'prettier', '--write', ...paths], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
