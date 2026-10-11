// Shared fixtures for the viewer evidence input tests. Not a test file: each card-evidence-input.*.test.ts
// imports only what it uses, so a group runs its own specs and setup.
import { expect, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as nodeModule from 'node:module';

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

import {
  getViewerEvidenceSourceFiles,
  type CatalogSpec,
} from '../../../../scripts/card-evidence-input';

export const repoRoot = resolve(import.meta.dirname, '../../../..');
export const scratch = process.env['MTG_EVIDENCE_TEST_SCRATCH'] ?? tmpdir();
export const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const cards = [
  'arcane-denial',
  'fabled-passage',
  'myriad-landscape',
  'smothering-tithe',
  'war-room',
];
// Independent discovery from emitted JavaScript (erased types), not SOURCE_FILES or the helper.
export function independentRuntimeBinding(card: string) {
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
export function sourceCatalog(): CatalogSpec[] {
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
export function fixture() {
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

export async function withFixture(run: (data: ReturnType<typeof fixture>) => Promise<void>) {
  const data = fixture();
  try {
    await run(data);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
}

export async function withCopiedFixture(
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
export function freshInstalledResolution(importer: string, specifier: string) {
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

export function bindCopiedInputs(f: ReturnType<typeof fixture>, copy: string, extra: string[]) {
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

export function prepareBoundRouting(
  f: ReturnType<typeof fixture>,
  copy: string,
  equalBytes: boolean,
) {
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
