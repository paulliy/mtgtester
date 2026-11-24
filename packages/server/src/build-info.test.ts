import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBuildInfo, readReleaseCommit, RELEASE_FILE } from './build-info';

const COMMIT = 'a'.repeat(40);
const dirs: string[] = [];
function releaseDir(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-release-'));
  dirs.push(dir);
  if (contents !== undefined) writeFileSync(join(dir, RELEASE_FILE), contents);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a release directory', () => {
  it('names the commit it was built from', () => {
    const dir = releaseDir(JSON.stringify({ commit: COMMIT }));
    expect(readReleaseCommit(dir)).toBe(COMMIT);
    expect(readBuildInfo(dir)).toEqual({ commit: COMMIT, branch: 'main', dirty: false });
  });

  it('is not a release without the file, or with a file that names no full commit', () => {
    expect(readReleaseCommit(releaseDir())).toBeNull();
    expect(readReleaseCommit(releaseDir('not json'))).toBeNull();
    expect(readReleaseCommit(releaseDir(JSON.stringify({ commit: 'abc123' })))).toBeNull();
    expect(readReleaseCommit(releaseDir('null'))).toBeNull();
  });
});
