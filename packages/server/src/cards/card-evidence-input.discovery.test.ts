// Viewer evidence input, group: runtime discovery and source lists. Split from card-evidence-input.test.ts.
// Shared fixtures live in card-evidence-input.fixtures.ts.
// Parser-boundary mocks are opt-in per test; all other calls use the real filesystem and git.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
}));

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';

import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import ts from 'typescript';
import { generateArcaneDenialVerificationEvidence } from '../../../../scripts/generate-arcane-denial-evidence';
import { generateFabledPassageVerificationEvidence } from '../../../../scripts/generate-fabled-passage-evidence';
import { generateMyriadLandscapeVerificationEvidence } from '../../../../scripts/generate-myriad-landscape-evidence';
import { generateSmotheringTitheVerificationEvidence } from '../../../../scripts/generate-smothering-tithe-evidence';
import { generateWarRoomVerificationEvidence } from '../../../../scripts/generate-war-room-evidence';
import {
  getViewerEvidenceSourceFiles,
  discoverGeneratorSourceFiles,
  loadViewerEvidence,
  validateCurrentEvidenceSources,
} from '../../../../scripts/card-evidence-input';

import {
  repoRoot,
  scratch,
  hash,
  cards,
  independentRuntimeBinding,
  withFixture,
} from './card-evidence-input.fixtures';

describe('viewer evidence input: runtime discovery and source lists', { timeout: 120_000 }, () => {
  // CPU-heavy discovery plus immediately rejected promises can starve worker IPC callbacks.
  afterEach(() => yieldToEventLoop());
  it.each(['dependency', 'pinned-data'] as const)(
    'rejects changed consumed %s bytes in a scratch copy at recheck',
    async (kind) => {
      await withFixture(async (f) => {
        const copy = resolve(f.root, 'repository');
        for (const path of f.options.sourceFiles) {
          mkdirSync(dirname(resolve(copy, path)), { recursive: true });
          writeFileSync(resolve(copy, path), readFileSync(resolve(repoRoot, path)));
        }
        mkdirSync(resolve(copy, 'node_modules/@mtg'), { recursive: true });
        for (const name of ['engine', 'shared', 'bot'])
          symlinkSync(
            resolve(copy, 'packages', name),
            resolve(copy, 'node_modules/@mtg', name),
            'junction',
          );
        const original = childProcess.execFileSync;
        const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((
          command: string,
          args: string[],
          options: { cwd?: string },
        ) => {
          if (command === 'git' && options?.cwd === fs.realpathSync(copy))
            return f.manifest.testedTree;
          return Reflect.apply(original, childProcess, [command, args, options]);
        }) as typeof original);
        try {
          const context = await loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy });
          const target =
            kind === 'dependency'
              ? 'packages/server/src/ai/turn-plan.ts'
              : 'packages/engine/tests/fixtures/reviewed-five-oracle.json';
          expect(context.files[target]).toBe(hash(readFileSync(resolve(copy, target))));
          writeFileSync(resolve(copy, target), readFileSync(resolve(copy, target), 'utf8') + '\n');
          expect(() => validateCurrentEvidenceSources(context, copy)).toThrow(
            /source bytes drifted/,
          );
        } finally {
          spy.mockRestore();
        }
      });
    },
  );

  it.each([
    ['arcane-denial', generateArcaneDenialVerificationEvidence],
    ['fabled-passage', generateFabledPassageVerificationEvidence],
    ['myriad-landscape', generateMyriadLandscapeVerificationEvidence],
    ['smothering-tithe', generateSmotheringTitheVerificationEvidence],
    ['war-room', generateWarRoomVerificationEvidence],
  ] as const)(
    'includes raw consumed-byte fingerprints in %s synthetic unit output',
    async (card, generate) => {
      await withFixture(async (f) => {
        const context = await loadViewerEvidence(f.paths, f.options);
        // Returned unit-test objects only: never invoke CLI/writeReport or promote these traces.
        const output = generate(context);
        const discovered = independentRuntimeBinding(card);
        for (const path of [...discovered.runtime, ...discovered.data])
          expect(output.workspaceRevision.files[path]).toBe(
            hash(readFileSync(resolve(repoRoot, path))),
          );
        expect(output.workspaceRevision.testedTree).toBe(context.testedTree);
        expect(output.workspaceRevision.reportSha256).toBe(context.reportSha256);
        const raw = Buffer.from('{ "b": 2, "a": 1 }\n');
        expect(hash(raw)).not.toBe(hash(Buffer.from('{"a":1,"b":2}')));
      });
    },
  );

  it.each([
    'import(value)',
    'require(value)',
    "export { value } from './missing'",
    "import './missing'",
  ])('fails closed for unresolved scratch runtime edge %s', (edge) => {
    const root = mkdtempSync(resolve(scratch, 'synthetic-runtime-'));
    try {
      writeFileSync(resolve(root, 'entry.ts'), edge);
      expect(() => discoverGeneratorSourceFiles(root, 'entry.ts')).toThrow(/unresolved/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers scratch side effects, reexports, literal require/import, JSON and erased types', () => {
    const root = mkdtempSync(resolve(scratch, 'synthetic-runtime-'));
    try {
      writeFileSync(
        resolve(root, 'entry.ts'),
        `
import type { Ignored } from './missing-type';
export type { Ignored } from './missing-type';
import './side';
export { value } from './reexport';
const required = require('./required');
void import('./dynamic');
const pinned = require('./pinned.json');
`,
      );
      for (const name of ['side', 'reexport', 'required', 'dynamic'])
        writeFileSync(resolve(root, `${name}.ts`), 'export const value = 1;');
      writeFileSync(resolve(root, 'pinned.json'), '{"syntheticUnitOnly":true}');
      expect(discoverGeneratorSourceFiles(root, 'entry.ts')).toEqual(
        [
          '.prettierrc',
          'entry.ts',
          'side.ts',
          'reexport.ts',
          'required.ts',
          'dynamic.ts',
          'pinned.json',
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "import { readFileSync as read } from 'node:fs'; read(value)",
    "import * as fs from 'node:fs'; fs.readFileSync(value)",
    "import { readFile } from 'node:fs/promises'; readFile(value)",
    "import { readFileSync } from 'node:fs'; readFileSync(new URL(value, import.meta.url))",
    "import { readFileSync } from 'node:fs'; readFileSync(new URL('./pin.json', value))",
    "import { readFileSync } from 'node:fs'; readFileSync(new URL('https://example.com/pin.json', import.meta.url))",
  ])('rejects unresolved scratch consumed data %s', (source) => {
    const root = mkdtempSync(resolve(scratch, 'synthetic-runtime-'));
    try {
      writeFileSync(resolve(root, 'entry.ts'), source);
      expect(() => discoverGeneratorSourceFiles(root, 'entry.ts')).toThrow(
        /unresolved consumed data/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds literal fixture URLs relative to the consuming module', () => {
    const root = mkdtempSync(resolve(scratch, 'synthetic-runtime-'));
    try {
      writeFileSync(
        resolve(root, 'entry.ts'),
        "import { readFileSync } from 'node:fs'; readFileSync(new URL('./pin.json', import.meta.url), 'utf8');",
      );
      writeFileSync(resolve(root, 'pin.json'), '{"pin":true}');
      expect(discoverGeneratorSourceFiles(root, 'entry.ts')).toContain('pin.json');
      writeFileSync(
        resolve(root, 'entry.ts'),
        "import { readFileSync } from 'node:fs'; readFileSync(new URL('../outside.json', import.meta.url), 'utf8');",
      );
      expect(() => discoverGeneratorSourceFiles(root, 'entry.ts')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    'packages/server/src/benchmark/replay.ts',
    'packages/server/src/benchmark/hash.ts',
    'packages/server/src/ai/turn-plan.ts',
    'packages/engine/tests/fixtures/reviewed-five-oracle.json',
  ])('rejects independently discovered consumed-byte omission %s', async (omitted) => {
    const discovered = independentRuntimeBinding('war-room');
    expect([...discovered.runtime, ...discovered.data]).toContain(omitted);
    await withFixture(async (f) => {
      f.manifest.files = f.manifest.files.filter((file) => file.path !== omitted);
      f.seal();
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/missing source/);
    });
  });

  it.each([
    'packages/server/src/match/player-yield.ts',
    'apps/web/src/stores/combatPlan.ts',
    'apps/web/src/components/DecisionPanel.vue',
    'playwright.config.ts',
  ])('rejects a missing real viewer runtime input %s', async (omitted) => {
    await withFixture(async (f) => {
      expect(f.options.sourceFiles).toContain(omitted);
      f.manifest.files = f.manifest.files.filter((file) => file.path !== omitted);
      f.seal();
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/missing source/);
    });
  });

  it.each(cards)(
    'binds independently discovered runtime and pinned inputs in %s output list',
    (card) => {
      const discovered = independentRuntimeBinding(card);
      const source = readFileSync(resolve(repoRoot, 'scripts/card-evidence-sources.ts'), 'utf8');
      const list = source.match(/const SOURCE_FILES = \[([\s\S]*?)\] as const;/)![1]!;
      const files = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      expect(new Set(files).size).toBe(files.length);
      for (const path of [...discovered.runtime, ...discovered.data]) expect(files).toContain(path);
      expect(discovered.data).toContain('packages/engine/tests/fixtures/reviewed-five-oracle.json');
    },
  );

  it('the shared source list includes helper, lab, runner, session, player and every generator once, with existing unique paths', () => {
    const union = new Set<string>();
    const source = ts.createSourceFile(
      'card-evidence-sources.ts',
      readFileSync(resolve(repoRoot, 'scripts/card-evidence-sources.ts'), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let paths: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'SOURCE_FILES') {
        const init = node.initializer;
        if (!init || !ts.isAsExpression(init) || !ts.isArrayLiteralExpression(init.expression))
          throw new Error('source list is not literal');
        paths = init.expression.elements.map((element) => {
          if (!ts.isStringLiteral(element)) throw new Error('nonliteral source');
          return element.text;
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths).size).toBe(paths.length);
    for (const required of [
      'scripts/card-evidence-input.ts',
      'apps/web/src/views/CardTestLabView.vue',
      'packages/server/src/match/runner.ts',
      'packages/server/src/match/session.ts',
      'apps/web/src/views/PlayerGameView.vue',
      'scripts/card-evidence-sources.ts',
      ...[
        'arcane-denial',
        'fabled-passage',
        'myriad-landscape',
        'smothering-tithe',
        'war-room',
      ].map((card) => `scripts/generate-${card}-evidence.ts`),
    ])
      expect(paths.filter((path) => path === required)).toHaveLength(1);
    for (const path of paths) {
      expect(fs.statSync(resolve(repoRoot, path)).isFile()).toBe(true);
      union.add(path);
    }
    // Flat filesystem inventory is independent of generator imports and the loader's recursive
    // routing walk. Vue and separately launched server inputs must also be in the exact union.
    for (const directory of [
      'packages/engine/src',
      'packages/bot/src',
      'packages/server/src',
      'packages/shared/src',
      'apps/web/src',
      'apps/web/public',
      'apps/web/e2e',
    ]) {
      if (!fs.existsSync(resolve(repoRoot, directory))) continue;
      for (const path of fs.readdirSync(resolve(repoRoot, directory), {
        recursive: true,
        encoding: 'utf8',
      })) {
        // Windows returns backslash-separated recursive names; repository paths are always '/'.
        const local = `${directory}/${path.replaceAll('\\', '/')}`;
        if (fs.statSync(resolve(repoRoot, local)).isFile()) union.add(local);
      }
    }
    for (const path of [
      'package.json',
      'bun.lock',
      'playwright.config.ts',
      'apps/web/package.json',
      'apps/web/index.html',
      'apps/web/vite.config.ts',
      'packages/server/package.json',
    ])
      if (fs.existsSync(resolve(repoRoot, path))) union.add(path);
    expect(getViewerEvidenceSourceFiles(repoRoot)).toEqual([...union].sort());
  });
});
