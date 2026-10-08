import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capturePrimitiveSources } from '../../../../scripts/contracts/primitive-evidence';

describe('primitive tree identity', () => {
  it.each(['staged', 'unstaged', 'untracked'])(
    'rejects %s bytes before identifying them as a committed tested tree',
    (state) => {
      const root = mkdtempSync(join(tmpdir(), 'primitive-dirty-tree-'));
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
      try {
        git('init');
        writeFileSync(join(root, 'tracked'), 'original');
        git('add', 'tracked');
        git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'fixture',
        );
        writeFileSync(join(root, state === 'untracked' ? 'new-source' : 'tracked'), 'changed');
        if (state === 'staged') git('add', 'tracked');
        expect(() => capturePrimitiveSources(root)).toThrow('working tree must be clean');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
