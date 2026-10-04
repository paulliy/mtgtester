import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AI_CONFIG } from '../ai/config';
import { createRunManifest } from './manifest';

describe('benchmark run manifests', () => {
  it('binds the run identity to its variant and the complete dirty worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'mtg-manifest-'));
    try {
      mkdirSync(join(root, 'packages', 'engine', 'src', 'cards'), { recursive: true });
      writeFileSync(join(root, 'tracked.txt'), 'tracked\n');
      execFileSync('git', ['init'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
      writeFileSync(join(root, 'untracked.txt'), 'must affect identity\n');

      const manifest = createRunManifest({
        repositoryRoot: root,
        baselineId: 'baseline-test-v1',
        variantId: 'candidate/test',
        role: 'tactician',
        mode: 'raw',
        trials: 1,
        suiteId: 'test-suite',
        suiteValue: { schemaVersion: 1, suiteId: 'test-suite', caseFiles: [] },
        cases: [],
        config: DEFAULT_AI_CONFIG,
        spendCapUsd: 1,
        maxAttempts: 1,
        concurrency: 1,
        timeoutMs: 1_000,
      });

      expect(manifest.variantId).toBe('candidate/test');
      expect(manifest.runId).toContain('candidate_test');
      expect(manifest.code.dirty).toBe(true);
      expect(manifest.code.dirtyPatchHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
