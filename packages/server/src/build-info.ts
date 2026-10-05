import type { GameReportBuild } from '@mtg/shared';

/**
 * The checkout the server is running from, for "Copy game report" (`GameReport.build`). Read once
 * at startup: a bug report has to say which code produced the game, and the branch name alone
 * does not pin it. Every field degrades to null outside a git checkout rather than failing.
 */
export function readBuildInfo(cwd: string): GameReportBuild {
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
