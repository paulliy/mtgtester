// ADR 0034 decision 1: Vite resolves an extensionless import to `.js` before `.ts`, so a compiled
// file beside its source makes every importer run the compiled copy instead of the source.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const COMPILED_SUFFIXES = ['.js', '.mjs', '.cjs', '.d.ts', '.js.map', '.d.ts.map'];

/** Returns each compiled file that sits beside a same-named `.ts` source. */
function shadowingFiles(files: readonly string[]): string[] {
  const sources = new Set(files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')));
  return files.filter((file) =>
    COMPILED_SUFFIXES.some(
      (suffix) => file.endsWith(suffix) && sources.has(`${file.slice(0, -suffix.length)}.ts`),
    ),
  );
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function testDirectories(): string[] {
  const packages = join(ROOT, 'packages');
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packages, entry.name, 'tests'))
    .filter((dir) => existsSync(dir));
}

describe('test harness integrity', () => {
  it('finds compiled files beside their sources', () => {
    expect(
      shadowingFiles([
        'tests/fixtures.ts',
        'tests/fixtures.js',
        'tests/fixtures.js.map',
        'tests/fixtures.d.ts',
        'tests/fixtures.d.ts.map',
        'tests/other.js',
        'tests/types.d.ts',
      ]),
    ).toEqual([
      'tests/fixtures.js',
      'tests/fixtures.js.map',
      'tests/fixtures.d.ts',
      'tests/fixtures.d.ts.map',
    ]);
  });

  it('has no compiled file shadowing a source under packages/*/tests', () => {
    const files = testDirectories().flatMap(walk);
    expect(files.length).toBeGreaterThan(0);
    expect(shadowingFiles(files).map((file) => relative(ROOT, file))).toEqual([]);
  });
});
