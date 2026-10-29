/**
 * The table server's module graph (plan M3 task 12): what `serve:table` and its game worker can
 * reach at run time. Built with `bun build --metafile`, so it is the bundler's own graph; type-only
 * imports do not appear in it and are allowed.
 *
 * The table entry points must reach no batch runner, no benchmark runtime and nothing that pulls
 * in the Card Test Lab scenarios, which set up games outside the rules (ADR 0031 decision 1).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ENTRIES = [
  'packages/server/src/cli/serve-table.ts',
  'packages/server/src/table/table-worker.ts',
];

interface Metafile {
  inputs: Record<string, { imports?: Array<{ path: string; external?: boolean }> }>;
}

const dir = mkdtempSync(join(tmpdir(), 'table-graph-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function graph(): Metafile {
  const metafile = join(dir, 'meta.json');
  const result = spawnSync(
    'bun',
    [
      'build',
      ...ENTRIES,
      '--target',
      'bun',
      '--outdir',
      join(dir, 'out'),
      `--metafile=${metafile}`,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (result.status !== 0) throw new Error(`bun build failed: ${result.stderr}`);
  return JSON.parse(readFileSync(metafile, 'utf8')) as Metafile;
}

/** Inputs the table entry points may not reach, with why. */
export function forbiddenModules(meta: Metafile): string[] {
  const found: string[] = [];
  for (const [path, input] of Object.entries(meta.inputs)) {
    if (path.startsWith('packages/server/src/batch/')) found.push(`${path} (batch runner)`);
    if (path.startsWith('packages/server/src/benchmark/')) found.push(`${path} (benchmark)`);
    if (/card-test-scenarios/.test(path)) found.push(`${path} (Card Test Lab scenarios)`);
    for (const imported of input.imports ?? []) {
      if (!imported.external && /card-test-scenarios/.test(imported.path)) {
        found.push(`${path} imports ${imported.path}`);
      }
    }
  }
  return found;
}

describe('table server module graph', () => {
  const meta = graph();

  it('bundles both entry points', () => {
    for (const entry of ENTRIES) expect(Object.keys(meta.inputs)).toContain(entry);
  });

  it('reaches no batch, benchmark or Card Test Lab scenario module', () => {
    expect(forbiddenModules(meta)).toEqual([]);
  });

  it('would catch a forbidden module', () => {
    expect(
      forbiddenModules({
        inputs: {
          'packages/server/src/batch/runner.ts': {},
          'packages/server/src/benchmark/suite.ts': {},
          'packages/server/src/match/x.ts': {
            imports: [{ path: 'packages/server/src/cards/card-test-scenarios.ts' }],
          },
        },
      }),
    ).toHaveLength(3);
  });
});
