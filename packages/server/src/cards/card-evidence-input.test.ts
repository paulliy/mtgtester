import { afterEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as nodeModule from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { generateArcaneDenialVerificationEvidence } from '../../../../scripts/generate-arcane-denial-evidence';
import { generateFabledPassageVerificationEvidence } from '../../../../scripts/generate-fabled-passage-evidence';
import { generateMyriadLandscapeVerificationEvidence } from '../../../../scripts/generate-myriad-landscape-evidence';
import { generateSmotheringTitheVerificationEvidence } from '../../../../scripts/generate-smothering-tithe-evidence';
import {
  generateWarRoomVerificationEvidence,
  WAR_ROOM_TRACE_PATHS,
} from '../../../../scripts/generate-war-room-evidence';
import {
  getViewerEvidenceSourceFiles,
  discoverGeneratorSourceFiles,
  loadViewerEvidence,
  parseViewerEvidenceOptions,
  type CatalogSpec,
  VIEWER_CATALOG,
  validateCurrentEvidenceSources,
  loadGeneratorViewerEvidence,
  type ValidatedViewerEvidence,
} from '../../../../scripts/card-evidence-input';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const scratch = process.env['MTG_EVIDENCE_TEST_SCRATCH'] ?? tmpdir();
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const cards = [
  'arcane-denial',
  'fabled-passage',
  'myriad-landscape',
  'smothering-tithe',
  'war-room',
];
// Independent discovery from emitted JavaScript (erased types), not SOURCE_FILES or the helper.
function independentRuntimeBinding(card: string) {
  const seen = new Set<string>();
  const data = new Set<string>();
  const graph: Record<string, string[]> = {};
  const pending = [`scripts/generate-${card}-evidence.ts`];
  while (pending.length) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFileSync(resolve(repoRoot, path), 'utf8');
    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const dependencies: string[] = [];
    for (const match of emitted.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith('.') && !specifier.startsWith('@mtg/')) continue;
      const resolved = specifier.startsWith('@mtg/')
        ? undefined
        : ts.resolveModuleName(
            specifier,
            resolve(repoRoot, path),
            {
              moduleResolution: ts.ModuleResolutionKind.Bundler,
              resolveJsonModule: true,
            },
            ts.sys,
          ).resolvedModule;
      const installed = specifier.startsWith('@mtg/')
        ? nodeModule.createRequire(resolve(repoRoot, path)).resolve(specifier)
        : undefined;
      if (!installed && !resolved)
        throw new Error(`Independent unresolved runtime import: ${path}: ${specifier}`);
      const actual = fs.realpathSync(installed ?? resolved!.resolvedFileName);
      const local = relative(repoRoot, actual).replaceAll('\\', '/');
      if (local.startsWith('../') || local.includes('/node_modules/'))
        throw new Error('Nonlocal workspace resolution');
      dependencies.push(local);
      pending.push(local);
    }
    // Independently enumerate the actual literal pinned fixture reads in emitted code.
    for (const match of emitted.matchAll(
      /readFileSync\)\([^;]*?resolve\)\(["']([^"']+\.json)["']/g,
    )) {
      const input = match[1]!;
      expect(fs.statSync(resolve(repoRoot, input)).isFile()).toBe(true);
      data.add(input);
    }
    graph[path] = dependencies;
  }
  const result = { runtime: [...seen].sort(), data: [...data].sort(), graph };
  if (process.env['MTG_EVIDENCE_TEST_SCRATCH'])
    writeFileSync(
      resolve(scratch, `independent-${card}-closure.json`),
      JSON.stringify(result, null, 2),
    );
  return result;
}
// Independent AST enumeration of actual test declarations, including describe title paths.
function sourceCatalog(): CatalogSpec[] {
  const file = 'card-test-lab.spec.ts';
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(repoRoot, 'apps/web/e2e', file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specs: CatalogSpec[] = [];
  function visit(node: ts.Node, parents: string[]) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      const title = node.arguments[0];
      if ((name === 'test' || name === 'test.describe') && title && ts.isStringLiteral(title)) {
        const titlePath = [...parents, title.text];
        if (name === 'test') {
          specs.push({ file, titlePath });
          return;
        }
        for (const argument of node.arguments.slice(1)) visit(argument, titlePath);
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, parents));
  }
  visit(source, []);
  return specs;
}

let fixtureSourcePaths: string[] | undefined;
function fixture() {
  const root = mkdtempSync(resolve(scratch, 'synthetic-parser-'));
  const outputRoot = resolve(root, 'output');
  mkdirSync(outputRoot);
  const tracePath = resolve(outputRoot, 'synthetic.zip');
  // UNIT TEST DATA ONLY. No browser or card acceptance evidence.
  const zip = execFileSync('python', [
    '-c',
    'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z:\n z.writestr("0-trace.trace",\'{"version":8,"type":"context-options","browserName":"chromium"}\\n{"type":"before","callId":"call@1","apiName":"page.goto"}\\n\')\n z.writestr("0-trace.network","")\nsys.stdout.buffer.write(b.getvalue())',
  ]);
  writeFileSync(tracePath, zip);
  const catalog = sourceCatalog();
  const suites: { title: string; file: string; specs: typeof specs; suites: unknown[] }[] = [];
  const specs = catalog.filter((x) => x.titlePath.length === 1).map(spec);
  const land = catalog.filter((x) => x.titlePath.length === 2).map(spec);
  function spec(item: CatalogSpec) {
    return {
      title: item.titlePath.at(-1)!,
      file: item.file,
      ok: true,
      tests: [
        {
          projectName: 'chromium',
          expectedStatus: 'passed',
          status: 'expected',
          results: [
            {
              status: 'passed',
              retry: 0,
              errors: [],
              attachments: [{ name: 'trace', contentType: 'application/zip', path: tracePath }],
            },
          ],
        },
      ],
    };
  }
  suites.push({
    title: 'card-test-lab.spec.ts',
    file: catalog[0]!.file,
    specs,
    suites: [{ title: 'land confirmation', file: catalog[0]!.file, specs: land, suites: [] }],
  });
  const report = {
    suites,
    errors: [],
    stats: { expected: catalog.length, unexpected: 0, flaky: 0, skipped: 0 },
  };
  const paths = {
    reportPath: resolve(root, 'report.json'),
    outputRoot,
    sourceManifestPath: resolve(root, 'sources.json'),
  };
  // Reuse fixture path names only; each manifest hashes fresh bytes, and the real loader
  // independently rediscovers and enforces the current complete binding on every load.
  const sourceFiles = [...(fixtureSourcePaths ??= getViewerEvidenceSourceFiles(repoRoot))];
  const manifest = {
    schemaVersion: 1,
    testedTree: execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD^{tree}'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim(),
    reportSha256: '',
    files: sourceFiles.map((path) => ({
      path,
      sha256: hash(readFileSync(resolve(repoRoot, path))),
    })),
  };
  function seal() {
    writeFileSync(paths.reportPath, JSON.stringify(report));
    manifest.reportSha256 = hash(readFileSync(paths.reportPath));
    writeFileSync(paths.sourceManifestPath, JSON.stringify(manifest));
  }
  seal();
  // Save raw test inputs outside the repo for independent review; working fixture always removed.
  if (process.env['MTG_EVIDENCE_TEST_SCRATCH']) {
    const saved = resolve(scratch, 'synthetic-unit-fixture');
    mkdirSync(saved, { recursive: true });
    for (const [name, bytes] of [
      ['trace.zip', zip],
      ['report.json', readFileSync(paths.reportPath)],
      ['sources.json', readFileSync(paths.sourceManifestPath)],
    ] as const)
      writeFileSync(resolve(saved, name), bytes);
  }
  return {
    root,
    paths,
    report,
    manifest,
    tracePath,
    zip,
    seal,
    options: { repoRoot, sourceFiles, catalog },
  };
}

async function withFixture(run: (data: ReturnType<typeof fixture>) => Promise<void>) {
  const data = fixture();
  try {
    await run(data);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
}

async function withCopiedFixture(
  run: (f: ReturnType<typeof fixture>, copy: string) => Promise<void>,
) {
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
      if (command === 'git' && options?.cwd === fs.realpathSync(copy)) return f.manifest.testedTree;
      return Reflect.apply(original, childProcess, [command, args, options]);
    }) as typeof original);
    try {
      await run(f, copy);
    } finally {
      spy.mockRestore();
    }
  });
}

// An independent process is essential: another createRequire in this worker retains Node caches.
function freshInstalledResolution(importer: string, specifier: string) {
  return JSON.parse(
    execFileSync(
      'node',
      [
        '--input-type=commonjs',
        '-e',
        `const fs=require('node:fs'),{createRequire}=require('node:module');
const [importer,specifier]=JSON.parse(fs.readFileSync(0,'utf8'));
const path=createRequire(importer).resolve(specifier);
process.stdout.write(JSON.stringify({path,realpath:fs.realpathSync(path),node:process.versions.node}));`,
      ],
      {
        input: JSON.stringify([importer, specifier]),
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    ),
  ) as { path: string; realpath: string; node: string };
}

function bindCopiedInputs(f: ReturnType<typeof fixture>, copy: string, extra: string[]) {
  const sourceFiles = [...new Set([...f.options.sourceFiles, ...extra])].sort();
  for (const card of cards) {
    const path = resolve(copy, `scripts/generate-${card}-evidence.ts`);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        /const SOURCE_FILES = \[[\s\S]*?\] as const;/,
        `const SOURCE_FILES = [${sourceFiles.map((path) => JSON.stringify(path).replaceAll('"', "'")).join(',')}] as const;`,
      ),
    );
  }
  f.options.sourceFiles = sourceFiles;
  f.manifest.files = sourceFiles.map((path) => ({
    path,
    sha256: hash(readFileSync(resolve(copy, path))),
  }));
  f.seal(); // Fixture preparation only, before any loader capture.
}

function prepareBoundRouting(f: ReturnType<typeof fixture>, copy: string, equalBytes: boolean) {
  const engine = resolve(copy, 'packages/engine/src');
  for (const name of ['route-a', 'route-b']) {
    mkdirSync(resolve(engine, name), { recursive: true });
    writeFileSync(
      resolve(engine, name, 'index.ts'),
      `export const unit = '${equalBytes ? 'same' : name}';`,
    );
  }
  writeFileSync(
    resolve(engine, 'index.ts'),
    "import './route/index'; import './route-a/index'; import './route-b/index';",
  );
  const junction = resolve(engine, 'route');
  symlinkSync(resolve(engine, 'route-a'), junction, 'junction');
  bindCopiedInputs(f, copy, [
    'packages/engine/src/route-a/index.ts',
    'packages/engine/src/route-b/index.ts',
  ]);
  return () => {
    rmSync(junction);
    symlinkSync(resolve(engine, 'route-b'), junction, 'junction');
  };
}

describe('viewer evidence input (synthetic parser data only)', { timeout: 30_000 }, () => {
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
        await expect(loadViewerEvidence(f.paths, { ...f.options, repoRoot: copy })).rejects.toThrow(
          /closure routing/,
        );
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
  it('owns exact mutable ZIP bytes across both validators and the recorded hash', async () => {
    await withFixture(async (f) => {
      const returned = Buffer.from(f.zip);
      const read = fs.readFileSync;
      let supplied = false;
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
        path: string,
        ...args: unknown[]
      ) => {
        if (path === f.tracePath && !supplied) {
          supplied = true;
          return returned;
        }
        return Reflect.apply(read, fs, [path, ...args]);
      }) as typeof read);
      const exec = childProcess.execFileSync;
      let input: Buffer | undefined;
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((
        command: string,
        args: string[],
        options: { input?: Buffer; timeout?: number; maxBuffer?: number },
      ) => {
        if (command === 'python') {
          input = options.input;
          expect(options.timeout).toBeGreaterThan(0);
          expect(options.timeout).toBeLessThanOrEqual(30_000);
          expect(options.maxBuffer).toBe(1024 * 1024);
        }
        return Reflect.apply(exec, childProcess, [command, args, options]);
      }) as typeof exec);
      try {
        const pending = loadViewerEvidence(f.paths, f.options);
        returned.fill(0); // Change the caller's original while asynchronous drainage is pending.
        const context = await pending;
        expect(input).not.toBe(returned);
        expect(input).toEqual(f.zip);
        expect(context.traces['war-room-viewer-colorless-mana']!.sha256).toBe(hash(f.zip));
      } finally {
        execSpy.mockRestore();
        readSpy.mockRestore();
      }
    });
  });
  it('rejects the compressed input limit before invoking Python', async () => {
    await withFixture(async (f) => {
      fs.truncateSync(f.tracePath, 128 * 1024 * 1024 + 1);
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/compressed byte limit/);
    });
  });
  it('rejects unavailable bundled reader without accepting a Python-only fallback', async () => {
    await withFixture(async (f) => {
      const spy = vi.spyOn(nodeModule, 'createRequire').mockImplementation(() => {
        throw new Error('synthetic unavailable');
      });
      try {
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(
          /validator unavailable/,
        );
      } finally {
        spy.mockRestore();
      }
    });
  });
  it.each(['success', 'error', 'deadline', 'entry-limit', 'member-limit', 'total-limit'] as const)(
    'closes synthetic reader and active streams on %s',
    async (kind) => {
      await withFixture(async (f) => {
        const reader = new EventEmitter();
        const close = vi.fn();
        const streams: PassThrough[] = [];
        let entries = 0;
        const fake = Object.assign(reader, {
          entryCount: kind === 'entry-limit' ? 20_001 : kind === 'total-limit' ? 3 : 2,
          close,
          readEntry() {
            if (entries === fake.entryCount) {
              reader.emit('end');
              return;
            }
            reader.emit('entry', {
              fileName: `${entries++}.trace`,
              generalPurposeBitFlag: 0,
              compressionMethod: 0,
              uncompressedSize:
                kind === 'member-limit'
                  ? 512 * 1024 * 1024 + 1
                  : kind === 'total-limit'
                    ? 512 * 1024 * 1024
                    : 0,
            });
          },
          openReadStream(_entry: unknown, callback: (error: null, stream: PassThrough) => void) {
            const stream = new PassThrough();
            streams.push(stream);
            callback(null, stream);
            queueMicrotask(() => {
              if (kind === 'error')
                stream.emit('error', new Error('synthetic decompression failure'));
              else if (kind === 'total-limit') {
                // Synthetic chunk lengths exercise the actual counters without allocating GiB.
                stream.emit('data', { length: 512 * 1024 * 1024 });
                stream.end();
              } else if (kind !== 'deadline') stream.end();
              else vi.advanceTimersByTime(30_001);
            });
          },
        });
        const requireFake = Object.assign(
          () => ({
            yauzl: {
              fromBuffer(
                _bytes: Buffer,
                _options: unknown,
                callback: (error: null, zip: typeof fake) => void,
              ) {
                callback(null, fake);
              },
            },
          }),
          { resolve: () => resolve(scratch, 'synthetic-bundle/package.json') },
        );
        const spy = vi
          .spyOn(nodeModule, 'createRequire')
          .mockReturnValue(requireFake as unknown as ReturnType<typeof nodeModule.createRequire>);
        if (kind === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          if (kind === 'success')
            await expect(loadViewerEvidence(f.paths, f.options)).resolves.toBeDefined();
          else
            await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(
              /ZIP|limit|deadline/,
            );
          expect(close).toHaveBeenCalledOnce();
          for (const stream of streams) expect(stream.destroyed).toBe(true);
        } finally {
          vi.useRealTimers();
          spy.mockRestore();
        }
      });
    },
  );
  it.each([
    'duplicate',
    'unsafe',
    'unsupported',
    'nontarget-size',
    'overdeclared',
    'hidden-nontarget',
  ] as const)('rejects synthetic ZIP member %s through the actual loader', async (kind) => {
    await withFixture(async (f) => {
      const zip = execFileSync('python', [
        '-c',
        `
import io,sys,zipfile,struct,zlib
b=io.BytesIO()
with zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z:
 z.writestr(zipfile.ZipInfo('0-trace.trace',(2020,1,1,0,0,0)),b'{"version":8,"type":"context-options"}\\n{"type":"before"}\\n')
 z.writestr(zipfile.ZipInfo(${kind === 'duplicate' ? "'0-trace.trace'" : kind === 'unsafe' ? "'../unsafe'" : "'resource.bin'"},(2020,1,1,0,0,0)),b'non-target unit member')
data=bytearray(b.getvalue()); first=data.index(b'PK\\x01\\x02'); second=data.index(b'PK\\x01\\x02',first+4)
local=struct.unpack_from('<I',data,second+42)[0]
kind='${kind}'
if kind=='unsupported': struct.pack_into('<H',data,second+10,99); struct.pack_into('<H',data,local+8,99)
if kind in ('nontarget-size','overdeclared'):
 size=struct.unpack_from('<I',data,second+24)[0]+(1 if kind=='overdeclared' else -1)
 struct.pack_into('<I',data,second+24,size); struct.pack_into('<I',data,local+22,size)
if kind=='hidden-nontarget':
 end=data.index(b'PK\\x05\\x06'); struct.pack_into('<HH',data,end+8,1,1)
sys.stdout.buffer.write(data)
`,
      ]);
      writeFileSync(f.tracePath, zip);
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/ZIP|member|path/);
    });
  });
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
  it.each(cards)(
    'binds independently discovered runtime and pinned inputs in %s output list',
    (card) => {
      const discovered = independentRuntimeBinding(card);
      const source = readFileSync(
        resolve(repoRoot, `scripts/generate-${card}-evidence.ts`),
        'utf8',
      );
      const list = source.match(/const SOURCE_FILES = \[([\s\S]*?)\] as const;/)![1]!;
      const files = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      expect(new Set(files).size).toBe(files.length);
      for (const path of [...discovered.runtime, ...discovered.data]) expect(files).toContain(path);
      expect(discovered.data).toContain('packages/engine/tests/fixtures/reviewed-five-oracle.json');
    },
  );
  it('rejects synthetic underdeclared member size with valid prefix CRC', async () => {
    await withFixture(async (f) => {
      // Positive control uses the real loader, not a mocked ZIP boundary.
      await expect(loadViewerEvidence(f.paths, f.options)).resolves.toBeDefined();
      const malformed = execFileSync('python', [
        '-c',
        `
import io,sys,zipfile,struct,zlib
prefix=b'{"version":8,"type":"context-options"}\\n{"type":"before"}\\n'
prefix+=b' '*(97-len(prefix))
payload=prefix+b'x'*29
assert len(prefix)==97 and len(payload)==126
b=io.BytesIO()
info=zipfile.ZipInfo("0-trace.trace",(2020,1,1,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED
with zipfile.ZipFile(b,"w") as z: z.writestr(info,payload)
data=bytearray(b.getvalue()); central=data.index(b'PK\\x01\\x02')
struct.pack_into('<I',data,14,zlib.crc32(prefix)); struct.pack_into('<I',data,22,len(prefix))
struct.pack_into('<I',data,central+16,zlib.crc32(prefix)); struct.pack_into('<I',data,central+24,len(prefix))
with zipfile.ZipFile(io.BytesIO(data)) as z:
 assert z.testzip() is None and z.read("0-trace.trace")==prefix
assert len(zlib.decompress(data[30+data[26]:central],-15))>len(prefix)
sys.stdout.buffer.write(data)
`,
      ]);
      writeFileSync(f.tracePath, malformed);
      if (process.env['MTG_EVIDENCE_TEST_SCRATCH'])
        writeFileSync(resolve(scratch, 'synthetic-underdeclared-97-126.zip'), malformed);
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/ZIP|size|bytes/);
    });
  });
  it('accepts only no flags or the strict complete spaced trio', () => {
    expect(parseViewerEvidenceOptions([])).toBeUndefined();
    expect(
      parseViewerEvidenceOptions([
        '--viewer-output',
        'out',
        '--viewer-source-manifest',
        'manifest',
        '--viewer-report',
        'report',
      ]),
    ).toEqual({ reportPath: 'report', outputRoot: 'out', sourceManifestPath: 'manifest' });
  });
  it.each(
    [
      ['--viewer-report=report'],
      ['report'],
      ['--bogus', 'value'],
      ['--viewer-report'],
      ['--viewer-report', ''],
      ['--viewer-report', '   '],
      ['--viewer-report', '--viewer-output'],
      ['--viewer-report', 'a', '--viewer-report', 'b'],
      ['--viewer-report', 'a', '--viewer-output', 'b'],
      [
        '--viewer-report',
        'a',
        '--viewer-output',
        'b',
        '--viewer-source-manifest',
        'c',
        'positional',
      ],
    ].map((args) => ({ args })),
  )('rejects invalid CLI tokens %#', ({ args }) =>
    expect(() => parseViewerEvidenceOptions(args)).toThrow(),
  );

  it('does not fall back when externally supplied CLI inputs are invalid', async () => {
    await expect(
      loadGeneratorViewerEvidence(
        [
          '--viewer-report',
          'missing',
          '--viewer-output',
          'missing',
          '--viewer-source-manifest',
          'missing',
        ],
        repoRoot,
      ),
    ).rejects.toThrow();
    // A main-less import and read-only loader have no writeReport path.
    for (const card of [
      'arcane-denial',
      'fabled-passage',
      'myriad-landscape',
      'smothering-tithe',
      'war-room',
    ]) {
      const source = readFileSync(
        resolve(repoRoot, `scripts/generate-${card}-evidence.ts`),
        'utf8',
      );
      const main = source.slice(source.indexOf('if (import.meta.main)'));
      expect(main.indexOf('await loadGeneratorViewerEvidence')).toBeGreaterThan(0);
      expect(main.indexOf('await loadGeneratorViewerEvidence')).toBeLessThan(
        main.indexOf('await writeReport'),
      );
    }
  });

  it('source lists include helper, lab, runner, session and player once, with existing unique paths', () => {
    const union = new Set<string>();
    for (const card of [
      'arcane-denial',
      'fabled-passage',
      'myriad-landscape',
      'smothering-tithe',
      'war-room',
    ]) {
      const source = ts.createSourceFile(
        card,
        readFileSync(resolve(repoRoot, `scripts/generate-${card}-evidence.ts`), 'utf8'),
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
        `scripts/generate-${card}-evidence.ts`,
      ])
        expect(paths.filter((path) => path === required)).toHaveLength(1);
      for (const path of paths) {
        expect(fs.statSync(resolve(repoRoot, path)).isFile()).toBe(true);
        union.add(path);
      }
    }
    expect(getViewerEvidenceSourceFiles(repoRoot)).toEqual([...union].sort());
  });

  it.each(['source', 'tree', 'validator-unavailable'] as const)(
    'checks %s using mocked parser boundaries only',
    async (kind) => {
      await withFixture(async (f) => {
        const context = await loadViewerEvidence(f.paths, f.options);
        if (kind === 'source') {
          const original = fs.readFileSync;
          const target = fs.realpathSync(resolve(repoRoot, '.prettierrc'));
          const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
            path: string,
            ...args: unknown[]
          ) => {
            if (path === target) return Buffer.from('changed');
            return Reflect.apply(original, fs, [path, ...args]);
          }) as typeof original);
          try {
            expect(() => validateCurrentEvidenceSources(context, repoRoot)).toThrow(
              /source bytes drift/,
            );
          } finally {
            spy.mockRestore();
          }
        } else {
          const original = childProcess.execFileSync;
          const spy = vi.spyOn(childProcess, 'execFileSync');
          if (kind === 'tree') {
            spy.mockImplementation(((command: string, args: string[], options: unknown) => {
              if (command === 'git' && args.includes('HEAD^{tree}')) return '0'.repeat(40);
              return Reflect.apply(original, childProcess, [command, args, options]);
            }) as typeof original);
            try {
              expect(() => validateCurrentEvidenceSources(context, repoRoot)).toThrow(/tree drift/);
            } finally {
              spy.mockRestore();
            }
          } else {
            spy.mockImplementation(((command: string, ...args: unknown[]) => {
              if (command === 'python')
                throw Object.assign(new Error('missing executable'), { code: 'ENOENT' });
              return Reflect.apply(original, childProcess, [command, ...args]);
            }) as typeof original);
            try {
              await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(
                /validator unavailable/,
              );
            } finally {
              spy.mockRestore();
            }
          }
        }
      });
    },
  );

  it('accepts report-directory relative attachments and additional frozen source entries', async () => {
    await withFixture(async (f) => {
      for (const spec of f.report.suites[0]!.specs)
        spec.tests[0]!.results[0]!.attachments[0]!.path = 'output/synthetic.zip';
      f.manifest.files.push({
        path: 'package.json',
        sha256: hash(readFileSync(resolve(repoRoot, 'package.json'))),
      });
      f.seal();
      const context = await loadViewerEvidence(f.paths, f.options);
      expect(context.traces['war-room-viewer-colorless-mana']!.path).toBe(f.tracePath);
      expect(context.files['package.json']).toBe(f.manifest.files.at(-1)!.sha256);
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
  it('Arcane adapter rejects a forged context before engine or output', () => {
    expect(() => generateArcaneDenialVerificationEvidence({} as ValidatedViewerEvidence)).toThrow(
      /loader-validated/,
    );
  });
  it.each([
    generateFabledPassageVerificationEvidence,
    generateMyriadLandscapeVerificationEvidence,
    generateSmotheringTitheVerificationEvidence,
    generateWarRoomVerificationEvidence,
  ])('adapter %# rejects raw maps and forged contexts before engine or output', (generator) => {
    expect(() => generator({} as ValidatedViewerEvidence)).toThrow(/loader-validated/);
    expect(() => generator(WAR_ROOM_TRACE_PATHS as unknown as ValidatedViewerEvidence)).toThrow(
      /loader-validated/,
    );
  });
  it('keeps War Room no-argument unresolved failure and null colorless default', () => {
    expect(WAR_ROOM_TRACE_PATHS['war-room-viewer-colorless-mana']).toBeNull();
    expect(() => generateWarRoomVerificationEvidence()).toThrow(/unresolved or missing/);
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
  it.each([
    'corrupt',
    'truncated',
    'empty',
    'nontrace',
    'traversal',
    'outside',
    'drive-relative',
    'root-relative',
  ] as const)('rejects %s trace input', async (kind) => {
    await withFixture(async (f) => {
      const target = f.report.suites[0]!.specs.find(
        (s) => s.title === 'War Room: colorless mana pays a spell cost',
      )!.tests[0]!.results[0]!.attachments[0]!;
      if (kind === 'corrupt') {
        const zip = Buffer.from(f.zip);
        const nameLength = zip.readUInt16LE(26);
        zip[30 + nameLength + 5] = zip[30 + nameLength + 5]! ^ 0xff;
        writeFileSync(f.tracePath, zip);
      }
      if (kind === 'truncated') writeFileSync(f.tracePath, f.zip.subarray(0, 60));
      if (kind === 'empty' || kind === 'nontrace')
        writeFileSync(
          f.tracePath,
          execFileSync('python', [
            '-c',
            `import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n ${kind === 'nontrace' ? 'z.writestr("readme.txt","not a trace")' : 'pass'}\nsys.stdout.buffer.write(b.getvalue())`,
          ]),
        );
      if (kind === 'traversal') target.path = 'output/../output/synthetic.zip';
      if (kind === 'outside') {
        target.path = resolve(f.root, 'outside.zip');
        writeFileSync(target.path, f.zip);
      }
      if (kind === 'drive-relative') target.path = 'C:synthetic.zip';
      if (kind === 'root-relative') target.path = '\\synthetic.zip';
      f.seal();
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow();
    });
  });
  it('rejects a partial trio rather than silently falling back', () => {
    expect(() => parseViewerEvidenceOptions(['--viewer-report', 'report.json'])).toThrow(
      /complete trio/,
    );
  });
  it.each(['missing', 'duplicate', 'corrupt'] as const)(
    'requires a valid retained trace for a new untap execution: %s',
    async (variant) => {
      await withFixture(async (f) => {
        const spec = f.report.suites[0]!.specs.find(
          (entry) => entry.title === 'Soldier On: affect and untap one target',
        );
        expect(spec).toBeDefined();
        const result = spec!.tests[0]!.results[0]!;
        if (variant === 'missing') result.attachments = [];
        if (variant === 'duplicate') result.attachments.push({ ...result.attachments[0]! });
        if (variant === 'corrupt') {
          const corrupt = resolve(f.paths.outputRoot, 'corrupt-new-trace.zip');
          writeFileSync(corrupt, 'not a trace archive');
          result.attachments[0]!.path = corrupt;
        }
        f.seal();
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow();
      });
    },
  );

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
});
