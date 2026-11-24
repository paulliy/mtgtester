import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameReportBuild } from '@mtg/shared';

/** Written by `.github/workflows/deploy.yml` at the root of a release, which has no `.git`. */
export const RELEASE_FILE = 'release.json';

/** The commit a release was built from, or `null` outside a release (or with a bad file). */
export function readReleaseCommit(cwd: string): string | null {
  const path = join(cwd, RELEASE_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const commit = (parsed as { commit?: unknown } | null)?.commit;
    return typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/**
 * The checkout the server is running from, for "Copy game report" (`GameReport.build`). Read once
 * at startup: a bug report has to say which code produced the game, and the branch name alone
 * does not pin it. A release names its commit in `release.json`; otherwise every field degrades to
 * null outside a git checkout rather than failing.
 */
export function readBuildInfo(cwd: string): GameReportBuild {
  // A release is built from main on GitHub, unchanged.
  const released = readReleaseCommit(cwd);
  if (released !== null) return { commit: released, branch: 'main', dirty: false };
  const git = (args: string[]): string | null => {
    try {
      const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      return result.exitCode === 0 ? result.stdout.toString().trim() : null;
    } catch {
      return null;
    }
  };
  const commit = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  return {
    commit,
    // A detached HEAD reports the literal "HEAD", which names no branch.
    branch: branch === null || branch === 'HEAD' ? null : branch,
    dirty: status === null ? null : status.length > 0,
  };
}
