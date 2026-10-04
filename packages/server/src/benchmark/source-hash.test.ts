import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256 } from './hash';
import { benchmarkSourceHashes } from './manifest';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

function writeSource(root: string, relative: string, lines: string[], eol: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lines.join(eol) + eol, 'utf8');
}

/** A minimal engine tree; the checkout's line terminator is the variable under test. */
function makeRoot(eol: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mtg-source-hash-'));
  writeSource(
    root,
    'packages/engine/src/index.ts',
    ['export const a = 1;', 'export const b = 2;'],
    eol,
  );
  writeSource(
    root,
    'packages/engine/src/cards/definition.ts',
    ['export type Card = { id: string };'],
    eol,
  );
  return root;
}

describe('benchmarkSourceHashes', () => {
  it('hashes an LF and a CRLF checkout of the same sources identically', () => {
    const lfRoot = makeRoot(LF);
    const crlfRoot = makeRoot(CRLF);
    try {
      const lf = benchmarkSourceHashes(lfRoot);
      const crlf = benchmarkSourceHashes(crlfRoot);
      expect(crlf.engine).toBe(lf.engine);
      expect(crlf.cardDefinitions).toBe(lf.cardDefinitions);
    } finally {
      rmSync(lfRoot, { recursive: true, force: true });
      rmSync(crlfRoot, { recursive: true, force: true });
    }
  });

  it('does not depend on git being present or the tree being a repository', () => {
    const root = makeRoot(LF);
    try {
      expect(existsSync(join(root, '.git'))).toBe(false);
      expect(benchmarkSourceHashes(root).engine).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('covers untracked .ts source but ignores non-source artifacts', () => {
    const root = makeRoot(LF);
    try {
      const baseline = benchmarkSourceHashes(root);

      // Generated/non-source artifacts must not perturb the seal.
      writeSource(root, 'packages/engine/src/build-info.json', ['{ "built": true }'], LF);
      writeSource(root, 'packages/engine/src/index.js', ['module.exports = {};'], LF);
      writeSource(root, 'packages/engine/src/cards/notes.md', ['# scratch'], LF);
      const withArtifacts = benchmarkSourceHashes(root);
      expect(withArtifacts.engine).toBe(baseline.engine);
      expect(withArtifacts.cardDefinitions).toBe(baseline.cardDefinitions);

      // Real source that git has never seen still changes engine semantics.
      writeSource(
        root,
        'packages/engine/src/testing/candidate-definition.ts',
        ['export const candidate = true;'],
        LF,
      );
      expect(benchmarkSourceHashes(root).engine).not.toBe(baseline.engine);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders entries by forward-slash relative path, not by native separator', () => {
    const root = mkdtempSync(join(tmpdir(), 'mtg-source-order-'));
    try {
      // On Windows the native separator is 0x5C, which sorts after '0' (0x30); the normalized
      // '/' (0x2F) sorts before it. These two names therefore swap unless paths are normalized
      // before sorting.
      writeSource(root, 'packages/engine/src/cards0.ts', ['export const zero = 0;'], CRLF);
      writeSource(root, 'packages/engine/src/cards/a.ts', ['export const a = 1;'], CRLF);
      writeSource(root, 'packages/engine/src/index.ts', ['export const i = 2;'], CRLF);

      const expected = sha256([
        { path: 'packages/engine/src/cards/a.ts', content: 'export const a = 1;' + LF },
        { path: 'packages/engine/src/cards0.ts', content: 'export const zero = 0;' + LF },
        { path: 'packages/engine/src/index.ts', content: 'export const i = 2;' + LF },
      ]);
      expect(benchmarkSourceHashes(root).engine).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
