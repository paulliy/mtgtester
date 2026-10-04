import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { confinedBenchmarkPath } from './paths';
import { loadSuite } from './cases';

function withTree(run: (root: string, outside: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'mtg-paths-'));
  const outside = mkdtempSync(join(tmpdir(), 'mtg-outside-'));
  mkdirSync(join(root, 'benchmarks', 'suites'), { recursive: true });
  mkdirSync(join(root, 'benchmarks', 'variants'), { recursive: true });
  mkdirSync(join(root, 'benchmarks', 'tactician', 'dev'), { recursive: true });
  try {
    run(root, outside);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

describe('benchmark path confinement', () => {
  it('allows a suite case to step out of suites while staying in benchmarks', () =>
    withTree((root) => {
      const suite = join(root, 'benchmarks', 'suites', 'core-fast.json');
      expect(
        confinedBenchmarkPath(root, '../tactician/dev/case.json', 'benchmarks', {
          origin: dirname(suite),
          relativeOnly: true,
        }),
      ).toBe(join(root, 'benchmarks', 'tactician', 'dev', 'case.json'));
    }));

  it('rejects traversal and absolute suite entries', () =>
    withTree((root) => {
      const origin = join(root, 'benchmarks', 'suites');
      expect(() =>
        confinedBenchmarkPath(root, '../../../outside.json', 'benchmarks', {
          origin,
          relativeOnly: true,
        }),
      ).toThrow(/escapes/);
      expect(() =>
        confinedBenchmarkPath(
          root,
          resolve(root, 'benchmarks/tactician/dev/case.json'),
          'benchmarks',
          { origin, relativeOnly: true },
        ),
      ).toThrow(/absolute/);
    }));

  it('restricts suite, case, variant, and nonexistent capture output paths', () =>
    withTree((root) => {
      expect(() =>
        confinedBenchmarkPath(root, 'benchmarks/tactician/dev/case.json', 'suites'),
      ).toThrow(/escapes/);
      expect(() => confinedBenchmarkPath(root, '../secret.json', 'benchmarks')).toThrow(/escapes/);
      expect(() =>
        confinedBenchmarkPath(root, 'benchmarks/variants/../../secret.json', 'variants'),
      ).toThrow(/escapes/);
      expect(confinedBenchmarkPath(root, 'benchmarks/new/case.json', 'benchmarks')).toBe(
        join(root, 'benchmarks', 'new', 'case.json'),
      );

      expect(() => confinedBenchmarkPath(root, 'benchmark-output/case.json', 'benchmarks')).toThrow(
        /escapes/,
      );
    }));

  it('rejects escaping entries when loading a suite', () =>
    withTree((root, outside) => {
      const suite = join(root, 'benchmarks', 'suites', 'escape.json');
      writeFileSync(
        suite,
        JSON.stringify({
          schemaVersion: 1,
          suiteId: 'escape',
          caseFiles: [join(outside, 'case.json')],
        }),
      );
      expect(() => loadSuite(suite)).toThrow(/absolute/);
      writeFileSync(
        suite,
        JSON.stringify({
          schemaVersion: 1,
          suiteId: 'escape',
          caseFiles: ['../../../outside.json'],
        }),
      );
      expect(() => loadSuite(suite)).toThrow(/escapes/);
    }));

  it('rejects symlink escapes, including a nonexistent child of a symlink', () =>
    withTree((root, outside) => {
      writeFileSync(join(outside, 'case.json'), '{}');
      const link = join(root, 'benchmarks', 'linked');
      try {
        symlinkSync(outside, link, 'dir');
      } catch {
        return;
      }
      expect(() =>
        confinedBenchmarkPath(root, 'benchmarks/linked/case.json', 'benchmarks'),
      ).toThrow(/symlink/);
      expect(() => confinedBenchmarkPath(root, 'benchmarks/linked/new.json', 'benchmarks')).toThrow(
        /symlink/,
      );
    }));

  it('rejects a benchmark root that is itself a symlink escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'mtg-linked-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'mtg-linked-outside-'));
    try {
      try {
        symlinkSync(outside, join(root, 'benchmarks'), 'dir');
      } catch {
        return;
      }
      expect(() => confinedBenchmarkPath(root, 'benchmarks/new.json', 'benchmarks')).toThrow(
        /symlink/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
