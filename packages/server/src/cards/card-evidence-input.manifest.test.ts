// Viewer evidence input, group: manifest, report, catalog and attachments. Split from card-evidence-input.test.ts.
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

import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  loadViewerEvidence,
  type CatalogSpec,
  VIEWER_CATALOG,
  validateCurrentEvidenceSources,
  type ValidatedViewerEvidence,
} from '../../../../scripts/card-evidence-input';

import { repoRoot, hash, sourceCatalog, withFixture } from './card-evidence-input.fixtures';

describe(
  'viewer evidence input: manifest, report, catalog and attachments',
  { timeout: 120_000 },
  () => {
    // CPU-heavy discovery plus immediately rejected promises can starve worker IPC callbacks.
    afterEach(() => yieldToEventLoop());
    it('accepts report-directory relative attachments and additional frozen source entries', async () => {
      await withFixture(async (f) => {
        for (const spec of f.report.suites[0]!.specs)
          spec.tests[0]!.results[0]!.attachments[0]!.path = 'output/synthetic.zip';
        f.manifest.files.push({
          path: 'README.md',
          sha256: hash(readFileSync(resolve(repoRoot, 'README.md'))),
        });
        f.seal();
        const context = await loadViewerEvidence(f.paths, f.options);
        expect(context.traces['war-room-viewer-colorless-mana']!.path).toBe(f.tracePath);
        expect(context.files['README.md']).toBe(f.manifest.files.at(-1)!.sha256);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.files)).toBe(true);
        expect(Object.isFrozen(context.traces)).toBe(true);
        expect(Object.isFrozen(context.traces['war-room-viewer-colorless-mana'])).toBe(true);
        expect(() => validateCurrentEvidenceSources({ ...context }, repoRoot)).toThrow(
          /loader-validated/,
        );
      });
    });

    it('rejects a real Windows junction escaping the output root', async () => {
      await withFixture(async (f) => {
        const outside = resolve(f.root, 'outside');
        mkdirSync(outside);
        writeFileSync(resolve(outside, 'trace.zip'), f.zip);
        const link = resolve(f.paths.outputRoot, 'escape');
        symlinkSync(outside, link, 'junction');
        const target = f.report.suites[0]!.specs.find((s) =>
          s.title.startsWith('War Room: colorless'),
        )!;
        target.tests[0]!.results[0]!.attachments[0]!.path = resolve(link, 'trace.zip');
        f.seal();
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/escapes root/);
      });
    });

    it.each([
      'version',
      'root-key',
      'entry-key',
      'duplicate-file',
      'bad-hash',
      'uppercase-hash',
      'bad-tree-type',
      'files-type',
      'escaped-duplicate-key',
      'nested-duplicate-key',
      'runtime-omission',
      'helper-omission',
      'caller-union',
    ] as const)('rejects strict manifest %s', async (kind) => {
      await withFixture(async (f) => {
        if (kind === 'version') f.manifest.schemaVersion = 2;
        if (kind === 'root-key') Object.assign(f.manifest, { unknown: true });
        if (kind === 'entry-key') Object.assign(f.manifest.files[0]!, { unknown: true });
        if (kind === 'duplicate-file') f.manifest.files.push(f.manifest.files[0]!);
        if (kind === 'bad-hash') f.manifest.files[0]!.sha256 = 'xyz';
        if (kind === 'uppercase-hash')
          f.manifest.files[0]!.sha256 = f.manifest.files[0]!.sha256.toUpperCase();
        if (kind === 'bad-tree-type') Object.assign(f.manifest, { testedTree: 1 });
        if (kind === 'files-type') Object.assign(f.manifest, { files: {} });
        if (kind === 'runtime-omission')
          f.manifest.files = f.manifest.files.filter(
            (file) => file.path !== 'packages/server/src/match/session.ts',
          );
        if (kind === 'helper-omission')
          f.manifest.files = f.manifest.files.filter(
            (file) => file.path !== 'scripts/card-evidence-input.ts',
          );
        if (kind === 'caller-union') f.options.sourceFiles.pop();
        f.seal();
        if (kind === 'escaped-duplicate-key')
          writeFileSync(
            f.paths.sourceManifestPath,
            readFileSync(f.paths.sourceManifestPath, 'utf8').replace(
              '"schemaVersion":1',
              '"\\u0073chemaVersion":0,"schemaVersion":1',
            ),
          );
        if (kind === 'nested-duplicate-key')
          writeFileSync(
            f.paths.sourceManifestPath,
            readFileSync(f.paths.sourceManifestPath, 'utf8').replace(
              '"sha256":',
              '"sha256":"bad","sha256":',
            ),
          );
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow();
      });
    });

    it.each([
      '../outside',
      './file',
      'a//b',
      '/absolute',
      'C:/absolute',
      'C:relative',
      '\\\\server\\share\\file',
      'back\\slash',
      'nul\0path',
      '',
    ])('rejects noncanonical manifest path %j', async (path) => {
      await withFixture(async (f) => {
        f.manifest.files[0]!.path = path;
        f.seal();
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/noncanonical/);
      });
    });

    it.each([
      'skipped',
      'flaky',
      'expected-failure',
      'spec-not-ok',
      'multi-project',
      'extra-result',
      'test-error',
      'result-error',
      'result-errors',
      'wrong-stats',
      'land-omission',
      'wrong-title',
      'wrong-file',
      'caller-catalog',
      'malformed-json',
      'malformed-results',
      'malformed-stats',
    ] as const)('rejects report %s', async (kind) => {
      await withFixture(async (f) => {
        const spec = f.report.suites[0]!.specs[0]!,
          test = spec.tests[0]!,
          result = test.results[0]!;
        if (kind === 'skipped') result.status = 'skipped';
        if (kind === 'flaky') test.status = 'flaky';
        if (kind === 'expected-failure') test.expectedStatus = 'failed';
        if (kind === 'spec-not-ok') spec.ok = false;
        if (kind === 'multi-project') spec.tests.push({ ...test, projectName: 'second' });
        if (kind === 'extra-result') test.results.push({ ...result, retry: 1 });
        if (kind === 'test-error') Object.assign(test, { error: { message: 'afterAll' } });
        if (kind === 'result-error') Object.assign(result, { error: { message: 'failed' } });
        if (kind === 'result-errors') (result.errors as unknown[]).push({ message: 'afterAll' });
        if (kind === 'wrong-stats') f.report.stats.expected--;
        if (kind === 'land-omission')
          (f.report.suites[0]!.suites[0] as { specs: unknown[] }).specs.pop();
        if (kind === 'wrong-title') spec.title = 'different title';
        if (kind === 'wrong-file') spec.file = 'other.spec.ts';
        if (kind === 'caller-catalog') f.options.catalog.pop();
        if (kind === 'malformed-results') Object.assign(test, { results: {} });
        if (kind === 'malformed-stats') Object.assign(f.report.stats, { skipped: '0' });
        f.seal();
        if (kind === 'malformed-json') {
          writeFileSync(f.paths.reportPath, '{bad');
          f.manifest.reportSha256 = hash(readFileSync(f.paths.reportPath));
          writeFileSync(f.paths.sourceManifestPath, JSON.stringify(f.manifest));
        }
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow();
      });
    });

    it.each([
      'missing',
      'duplicate',
      'body-only',
      'wrong-type',
      'nonzip',
      'missing-file',
      'not-file',
      'crc',
      'encrypted',
      'bad-trace-json',
      'empty-trace',
      'unc-incomplete',
      'slash-root',
      'nul-path',
      'missing-output',
      'output-file',
    ] as const)('rejects target attachment %s', async (kind) => {
      await withFixture(async (f) => {
        const attachments = f.report.suites[0]!.specs.find((s) =>
          s.title.startsWith('War Room: colorless'),
        )!.tests[0]!.results[0]!.attachments;
        const trace = attachments[0]!;
        if (kind === 'missing') attachments.length = 0;
        if (kind === 'duplicate') attachments.push({ ...trace });
        if (kind === 'body-only') {
          delete (trace as unknown as Record<string, unknown>)['path'];
          Object.assign(trace, { body: f.zip.toString('base64') });
        }
        if (kind === 'wrong-type') trace.contentType = 'text/plain';
        if (kind === 'nonzip') {
          trace.path = resolve(f.paths.outputRoot, 'trace.txt');
          writeFileSync(trace.path, f.zip);
        }
        if (kind === 'missing-file') trace.path = resolve(f.paths.outputRoot, 'missing.zip');
        if (kind === 'not-file') {
          trace.path = resolve(f.paths.outputRoot, 'directory.zip');
          mkdirSync(trace.path);
        }
        if (kind === 'crc' || kind === 'encrypted') {
          const zip = Buffer.from(f.zip),
            central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
          if (kind === 'crc') zip.writeUInt32LE(0, central + 16);
          else {
            zip.writeUInt16LE(zip.readUInt16LE(6) | 1, 6);
            zip.writeUInt16LE(zip.readUInt16LE(central + 8) | 1, central + 8);
          }
          writeFileSync(f.tracePath, zip);
        }
        if (kind === 'empty-trace' || kind === 'bad-trace-json')
          writeFileSync(
            f.tracePath,
            execFileSync('python', [
              '-c',
              `import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z: z.writestr("0-trace.trace",${kind === 'empty-trace' ? '""' : '"{bad"'})\nsys.stdout.buffer.write(b.getvalue())`,
            ]),
          );
        if (kind === 'unc-incomplete') trace.path = '\\\\server';
        if (kind === 'slash-root') trace.path = '/output/trace.zip';
        if (kind === 'nul-path') trace.path = 'bad\0.zip';
        if (kind === 'missing-output') f.paths.outputRoot = resolve(f.root, 'missing');
        if (kind === 'output-file') f.paths.outputRoot = f.tracePath;
        f.seal();
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow();
      });
    });

    it('rejects cast plain contexts', () => {
      expect(() => validateCurrentEvidenceSources({} as ValidatedViewerEvidence, repoRoot)).toThrow(
        /validated/,
      );
    });

    it('rejects stale validated trace bytes at consumption', async () => {
      await withFixture(async (f) => {
        const context = await loadViewerEvidence(f.paths, f.options);
        expect(() => validateCurrentEvidenceSources(context, repoRoot)).not.toThrow();
        writeFileSync(f.tracePath, Buffer.from('replaced after validation'));
        expect(() => validateCurrentEvidenceSources(context, repoRoot)).toThrow(/trace.*drift/);
      });
    });

    it('revalidates previously accepted report bytes at consumption', async () => {
      await withFixture(async (f) => {
        const context = await loadViewerEvidence(f.paths, f.options);
        writeFileSync(f.paths.reportPath, readFileSync(f.paths.reportPath, 'utf8') + ' ');
        expect(() => validateCurrentEvidenceSources(context, repoRoot)).toThrow(/report.*drift/);
      });
    });

    it('pins exact complete file/title paths to independent current spec declarations', () => {
      const key = (s: CatalogSpec) => JSON.stringify([s.file, ...s.titlePath]);
      expect(VIEWER_CATALOG.map(key).sort()).toEqual(sourceCatalog().map(key).sort());
      expect(sourceCatalog().filter((s) => s.titlePath[0] === 'land confirmation')).toHaveLength(7);
    });

    it('loads the complete real-schema catalog with exact report/source/ZIP hashes', async () => {
      await withFixture(async (f) => {
        const result = await loadViewerEvidence(f.paths, f.options);
        expect(result.reportSha256).toBe(f.manifest.reportSha256);
        expect(result.testedTree).toBe(f.manifest.testedTree);
        expect(Object.keys(result.traces)).toHaveLength(VIEWER_CATALOG.length);
        expect(result.traces['war-room-viewer-colorless-mana']).toEqual({
          path: f.tracePath,
          sha256: hash(f.zip),
        });
      });
    });

    it('accepts the trusted secondary suite filename and rejects an unknown filename', async () => {
      await withFixture(async (f) => {
        const secondary = f.report.suites.find(
          (suite) => suite.file === 'combat-trigger-regressions.spec.ts',
        );
        expect(secondary?.title).toBe('combat-trigger-regressions.spec.ts');
        expect(secondary?.specs).toHaveLength(9);
        expect(await loadViewerEvidence(f.paths, f.options)).toBeDefined();

        secondary!.file = 'unknownfilename.spec.ts';
        secondary!.title = 'unknownfilename.spec.ts';
        f.seal();
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/catalog file/);
      });
    });

    it.each(['missing-nontarget', 'duplicate', 'failed', 'retry', 'afterAll'] as const)(
      'rejects %s catalog execution',
      async (kind) => {
        await withFixture(async (f) => {
          const first = f.report.suites[0]!.specs[0]!;
          if (kind === 'missing-nontarget') {
            f.report.suites[0]!.specs.shift();
            f.report.stats.expected--;
          }
          if (kind === 'duplicate') {
            f.report.suites[0]!.specs.push(first);
            f.report.stats.expected++;
          }
          if (kind === 'failed') first.tests[0]!.results[0]!.status = 'failed';
          if (kind === 'retry') first.tests[0]!.results[0]!.retry = 1;
          if (kind === 'afterAll')
            (f.report.errors as unknown[]).push({ message: 'coverage guard failed' });
          f.seal();
          await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(
            /catalog|execution|error/,
          );
        });
      },
    );

    it('rejects a wrong actual Git tree', async () => {
      await withFixture(async (f) => {
        f.manifest.testedTree = '0'.repeat(40);
        f.seal();
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/tree/);
      });
    });

    it.each(['report', 'source', 'omission', 'duplicate-key'] as const)(
      'rejects %s manifest drift',
      async (kind) => {
        await withFixture(async (f) => {
          if (kind === 'report')
            writeFileSync(f.paths.reportPath, readFileSync(f.paths.reportPath, 'utf8') + ' ');
          if (kind === 'source') {
            f.manifest.files[0]!.sha256 = '0'.repeat(64);
            f.seal();
          }
          if (kind === 'omission') {
            f.manifest.files.pop();
            f.seal();
          }
          if (kind === 'duplicate-key')
            writeFileSync(
              f.paths.sourceManifestPath,
              readFileSync(f.paths.sourceManifestPath, 'utf8').replace(
                '"schemaVersion":1',
                '"schemaVersion":0,"schemaVersion":1',
              ),
            );
          await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(
            /report|source|manifest|Duplicate/,
          );
        });
      },
    );
  },
);
