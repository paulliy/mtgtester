/**
 * The table app's bundle holds none of the tester's views (plan M6 task 1): no statistics, no
 * debug panel, no batch views, no Card Test Lab, no spectator setup. Built for real with
 * `vite build --mode table` into a temporary directory, then read from its manifest and chunks.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '../..');
const out = mkdtempSync(join(tmpdir(), 'table-bundle-'));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

const TESTER_ONLY = [
  'StatsView',
  'DebugView',
  'BatchSetupView',
  'BatchRunsView',
  'ImportReportView',
  'CardTestLabView',
  'SetupView',
  'DealsPreviewView',
];

describe('the table bundle', () => {
  const build = spawnSync('bunx', ['vite', 'build', '--mode', 'table', '--outDir', out], {
    cwd: WEB,
    encoding: 'utf8',
    timeout: 120_000,
  });

  it('builds with a manifest', () => {
    expect(build.status, build.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(out, '.vite', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(manifest)).toContain('src/table/TableView.vue');
  });

  it('contains no tester view, by manifest entry or by chunk name', () => {
    const manifest = readFileSync(join(out, '.vite', 'manifest.json'), 'utf8');
    const chunks = readdirSync(join(out, 'assets'));
    for (const view of TESTER_ONLY) {
      expect(manifest, view).not.toContain(view);
      expect(
        chunks.some((file) => file.startsWith(view)),
        view,
      ).toBe(false);
    }
  });
});
