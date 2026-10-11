// Viewer evidence input, group: installed resolution and routing drift. Split from card-evidence-input.test.ts.
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
import { resolve } from 'node:path';

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
  scratch,
  hash,
  withCopiedFixture,
  freshInstalledResolution,
  bindCopiedInputs,
  prepareBoundRouting,
} from './card-evidence-input.fixtures';

describe(
  'viewer evidence input: installed resolution and routing drift',
  { timeout: 120_000 },
  () => {
    // CPU-heavy discovery plus immediately rejected promises can starve worker IPC callbacks.
    afterEach(() => yieldToEventLoop());
    it('rejects fresh installed engine junction drift through the branded recheck', async () => {
      await withCopiedFixture(async (f, copy) => {
        const context = await loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy });
        expect(() => validateCurrentEvidenceSources(context, copy)).not.toThrow();
        const importer = resolve(copy, 'scripts/generate-war-room-evidence.ts');
        const before = freshInstalledResolution(importer, '@mtg/engine');
        const captured = Object.fromEntries(
          Object.keys(context.files).map((path) => [path, hash(readFileSync(resolve(copy, path)))]),
        );
        const report = hash(readFileSync(f.paths.reportPath));
        const manifest = hash(readFileSync(f.paths.sourceManifestPath));
        const alternate = resolve(copy, 'packages/alternate-engine');
        mkdirSync(resolve(alternate, 'src'), { recursive: true });
        writeFileSync(
          resolve(alternate, 'package.json'),
          readFileSync(resolve(copy, 'packages/engine/package.json')),
        );
        writeFileSync(resolve(alternate, 'src/index.ts'), 'export const unboundSentinel = true;');
        const junction = resolve(copy, 'node_modules/@mtg/engine');
        rmSync(junction); // Remove only the scratch junction, never its target.
        symlinkSync(alternate, junction, 'junction');
        const after = freshInstalledResolution(importer, '@mtg/engine');
        expect(after.realpath).toBe(fs.realpathSync(resolve(alternate, 'src/index.ts')));
        expect(after.realpath).not.toBe(before.realpath);
        expect(context.files['packages/alternate-engine/src/index.ts']).toBeUndefined();
        expect(hash(readFileSync(f.paths.reportPath))).toBe(report);
        expect(hash(readFileSync(f.paths.sourceManifestPath))).toBe(manifest);
        for (const [path, bytes] of Object.entries(captured))
          expect(hash(readFileSync(resolve(copy, path)))).toBe(bytes);
        let rejection = '';
        try {
          validateCurrentEvidenceSources(context, copy);
        } catch (error) {
          rejection = (error as Error).message;
        }
        if (process.env['MTG_EVIDENCE_TEST_SCRATCH'])
          writeFileSync(
            resolve(scratch, `resolution-drift-${rejection ? 'rejected' : 'accepted'}.json`),
            JSON.stringify(
              {
                syntheticUnitOnly: true,
                unchangedPositiveControl: true,
                before,
                after,
                captured,
                reportSha256: report,
                manifestSha256: manifest,
                reportAndManifestResealed: false,
                alternateBound: false,
                recheckAccepted: !rejection,
                rejection,
              },
              null,
              2,
            ),
          );
        expect(rejection).toMatch(/binding|closure|resolution|routing/);
      });
    });

    it.each([false, true])(
      'rejects already-bound routing drift with equal bytes=%s',
      async (equal) => {
        await withCopiedFixture(async (f, copy) => {
          const redirect = prepareBoundRouting(f, copy, equal);
          const context = await loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy });
          expect(() => validateCurrentEvidenceSources(context, copy)).not.toThrow();
          const union = getViewerEvidenceSourceFiles(copy);
          redirect();
          expect(getViewerEvidenceSourceFiles(copy)).toEqual(union);
          for (const [path, sha256] of Object.entries(context.files))
            expect(hash(readFileSync(resolve(copy, path)))).toBe(sha256);
          expect(() => validateCurrentEvidenceSources(context, copy)).toThrow(/closure routing/);
        });
      },
    );

    it.each(['source', 'data'] as const)(
      'rejects equal-byte captured %s alias retarget',
      async (kind) => {
        await withCopiedFixture(async (f, copy) => {
          for (const name of ['input-a', 'input-b']) {
            mkdirSync(resolve(copy, name));
            writeFileSync(resolve(copy, name, 'unit.json'), '{"syntheticUnitOnly":true}');
          }
          const alias = resolve(copy, 'input-alias');
          symlinkSync(resolve(copy, 'input-a'), alias, 'junction');
          if (kind === 'data')
            writeFileSync(
              resolve(copy, 'packages/engine/src/index.ts'),
              "import {readFileSync} from 'node:fs'; readFileSync('input-alias/unit.json');",
            );
          bindCopiedInputs(f, copy, [
            'input-alias/unit.json',
            'input-a/unit.json',
            'input-b/unit.json',
          ]);
          const context = await loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy });
          expect(() => validateCurrentEvidenceSources(context, copy)).not.toThrow();
          rmSync(alias);
          symlinkSync(resolve(copy, 'input-b'), alias, 'junction');
          for (const [path, sha256] of Object.entries(context.files))
            expect(hash(readFileSync(resolve(copy, path)))).toBe(sha256);
          expect(() => validateCurrentEvidenceSources(context, copy)).toThrow(/identity|closure/);
        });
      },
    );

    it.each(['unresolvable', 'escaped', 'new-unbound', 'metadata-name'] as const)(
      'fails closed for current installed dependency %s',
      async (kind) => {
        await withCopiedFixture(async (f, copy) => {
          const context = await loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy });
          const junction = resolve(copy, 'node_modules/@mtg/engine');
          if (kind === 'metadata-name') {
            const path = resolve(copy, 'packages/engine/package.json');
            const metadata = JSON.parse(readFileSync(path, 'utf8'));
            metadata.name = '@mtg/wrong';
            writeFileSync(path, JSON.stringify(metadata));
          } else {
            rmSync(junction);
            if (kind !== 'unresolvable') {
              const alternate = resolve(kind === 'escaped' ? f.root : copy, 'alternate-engine');
              mkdirSync(resolve(alternate, 'src'), { recursive: true });
              writeFileSync(
                resolve(alternate, 'package.json'),
                readFileSync(resolve(copy, 'packages/engine/package.json')),
              );
              writeFileSync(resolve(alternate, 'src/index.ts'), 'export const unbound = true;');
              symlinkSync(alternate, junction, 'junction');
              expect(
                freshInstalledResolution(
                  resolve(copy, 'scripts/generate-war-room-evidence.ts'),
                  '@mtg/engine',
                ).realpath,
              ).toBe(fs.realpathSync(resolve(alternate, 'src/index.ts')));
            }
          }
          expect(() => validateCurrentEvidenceSources(context, copy)).toThrow(
            /unresolved|root|binding|package name/,
          );
        });
      },
    );

    it('freshly discovers added consumed-data membership at recheck', async () => {
      await withCopiedFixture(async (f, copy) => {
        const path = resolve(copy, 'packages/engine/src/index.ts');
        const context = await loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy });
        writeFileSync(resolve(copy, 'added-unit.json'), '{}');
        writeFileSync(
          path,
          readFileSync(path, 'utf8') +
            "\nimport {readFileSync} from 'node:fs'; readFileSync('added-unit.json');",
        );
        expect(() => validateCurrentEvidenceSources(context, copy)).toThrow(
          /incomplete generator source binding/,
        );
      });
    });

    it('compares the initial capture after asynchronous ZIP validation', async () => {
      await withCopiedFixture(async (f, copy) => {
        const redirect = prepareBoundRouting(f, copy, true);
        const original = childProcess.execFileSync;
        let redirected = false;
        const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((
          command: string,
          args: string[],
          options: unknown,
        ) => {
          const result = Reflect.apply(original, childProcess, [command, args, options]);
          if (command === 'python' && args[1]?.includes('ZipFile(io.BytesIO') && !redirected) {
            redirected = true;
            redirect();
          }
          return result;
        }) as typeof original);
        try {
          await expect(
            loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy }),
          ).rejects.toThrow(/closure routing/);
          expect(redirected).toBe(true);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('fails closed when the fresh Node resolver is unavailable', async () => {
      await withCopiedFixture(async (f, copy) => {
        const context = await loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy });
        const original = childProcess.execFileSync;
        const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((
          command: string,
          ...args: unknown[]
        ) => {
          if (command === 'node') throw new Error('unit unavailable resolver');
          return Reflect.apply(original, childProcess, [command, ...args]);
        }) as typeof original);
        try {
          expect(() => validateCurrentEvidenceSources(context, copy)).toThrow(
            /fresh installed Node resolution unavailable/,
          );
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('uses installed require exports rather than TypeScript types or import exports', () => {
      const root = mkdtempSync(resolve(scratch, 'synthetic-hybrid-'));
      try {
        const engine = resolve(root, 'packages/engine');
        mkdirSync(resolve(engine, 'src'), { recursive: true });
        mkdirSync(resolve(root, 'node_modules/@mtg'), { recursive: true });
        symlinkSync(engine, resolve(root, 'node_modules/@mtg/engine'), 'junction');
        writeFileSync(resolve(root, 'entry.ts'), "import '@mtg/engine';");
        writeFileSync(
          resolve(engine, 'package.json'),
          JSON.stringify({
            name: '@mtg/engine',
            exports: {
              '.': {
                types: './src/types.ts',
                import: './src/import.ts',
                require: './src/require.ts',
              },
            },
          }),
        );
        for (const name of ['types', 'import', 'require'])
          writeFileSync(resolve(engine, `src/${name}.ts`), 'export const unit = true;');
        const independent = freshInstalledResolution(resolve(root, 'entry.ts'), '@mtg/engine');
        expect(independent.realpath).toBe(fs.realpathSync(resolve(engine, 'src/require.ts')));
        const bundler = ts.resolveModuleName(
          '@mtg/engine',
          resolve(root, 'entry.ts'),
          { moduleResolution: ts.ModuleResolutionKind.Bundler },
          ts.sys,
        ).resolvedModule;
        expect(fs.realpathSync(bundler!.resolvedFileName)).not.toBe(independent.realpath);
        expect(discoverGeneratorSourceFiles(root, 'entry.ts')).toEqual([
          '.prettierrc',
          'entry.ts',
          'packages/engine/package.json',
          'packages/engine/src/require.ts',
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.each([
      ['arcane-denial', generateArcaneDenialVerificationEvidence],
      ['fabled-passage', generateFabledPassageVerificationEvidence],
      ['myriad-landscape', generateMyriadLandscapeVerificationEvidence],
      ['smothering-tithe', generateSmotheringTitheVerificationEvidence],
      ['war-room', generateWarRoomVerificationEvidence],
    ] as const)(
      'rejects bound routing drift at the %s exported generator entry',
      async (_card, generate) => {
        await withCopiedFixture(async (f, copy) => {
          const redirect = prepareBoundRouting(f, copy, true);
          const context = await loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy });
          const cwd = vi.spyOn(process, 'cwd').mockReturnValue(copy);
          try {
            expect(() => validateCurrentEvidenceSources(context, process.cwd())).not.toThrow();
            redirect();
            // The actual generator guard rejects routing before fingerprints or scenario execution.
            expect(() => generate(context)).toThrow(/closure routing/);
          } finally {
            cwd.mockRestore();
          }
        });
      },
    );

    it('invalidates a loaded viewer receipt when a new owned runtime file appears', async () => {
      await withCopiedFixture(async (f, copy) => {
        const evidence = await loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy });
        const path = resolve(copy, 'apps/web/src/new-runtime-input.ts');
        writeFileSync(path, 'export const newlyLoadedBehavior = true;\n');
        expect(() => validateCurrentEvidenceSources(evidence, copy)).toThrow(
          /dependency closure routing drifted/,
        );
      });
    });

    it('rejects runtime directory links escaping the captured repository', async () => {
      await withCopiedFixture(async (f, copy) => {
        symlinkSync(f.root, resolve(copy, 'apps/web/src/outside-repository'), 'junction');
        expect(() => getViewerEvidenceSourceFiles(copy)).toThrow(
          /runtime directory escapes repository/,
        );
      });
    });
  },
);
