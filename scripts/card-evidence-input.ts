import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import ts from 'typescript';
import { dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

export interface ViewerInputPaths {
  reportPath: string;
  outputRoot: string;
  sourceManifestPath: string;
}

export interface CatalogSpec {
  readonly file: string;
  readonly titlePath: readonly string[];
}

const validatedBrand: unique symbol = Symbol('validated viewer evidence');
export interface ValidatedViewerEvidence {
  readonly [validatedBrand]: true;
  readonly testedTree: string;
  readonly reportSha256: string;
  readonly files: Readonly<Record<string, string>>;
  readonly traces: Readonly<Record<string, Readonly<{ path: string; sha256: string }>>>;
}

const contexts = new WeakMap<
  ValidatedViewerEvidence,
  {
    repoRoot: string;
    outputRoot: string;
    paths: ViewerInputPaths;
    manifestSha256: string;
    discoveryIdentity: string;
    sourceIdentity: string;
  }
>();

export function validateCurrentEvidenceSources(
  context: ValidatedViewerEvidence,
  repoRoot: string,
): void {
  const captured = contexts.get(context);
  requireInput(captured, 'a loader-validated context is required');
  const root = realpathSync(repoRoot);
  requireInput(root === captured.repoRoot, 'validated repository changed');
  requireInput(
    discoverViewerEvidenceSources(root).identity === captured.discoveryIdentity,
    'dependency closure routing drifted',
  );
  requireInput(
    sourceIdentity(root, Object.keys(context.files)) === captured.sourceIdentity,
    'captured source identity drifted',
  );
  const tree = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD^{tree}'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  requireInput(tree === context.testedTree, 'tested tree drifted');
  requireInput(
    hash(readFileSync(captured.paths.reportPath)) === context.reportSha256,
    'report bytes drifted',
  );
  requireInput(
    hash(readFileSync(captured.paths.sourceManifestPath)) === captured.manifestSha256,
    'source manifest bytes drifted',
  );
  for (const [path, sha256] of Object.entries(context.files)) {
    requireInput(
      hash(readFileSync(confinedFile(root, resolve(root, path)))) === sha256,
      `source bytes drifted: ${path}`,
    );
  }
  requireInput(
    realpathSync(captured.paths.outputRoot) === captured.outputRoot,
    'output root drifted',
  );
  for (const trace of Object.values(context.traces)) {
    const path = confinedFile(captured.outputRoot, trace.path);
    requireInput(
      path === trace.path && hash(readFileSync(path)) === trace.sha256,
      'trace bytes drifted',
    );
  }
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Evidence documents reject duplicate JSON keys before schema validation. */
export function parseEvidenceJson(text: string): unknown {
  return uniqueJson(text);
}
function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Viewer evidence input: ${message}`);
}
function record(value: unknown): Record<string, unknown> {
  requireInput(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'malformed object',
  );
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  requireInput(Object.keys(value).sort().join('|') === keys.sort().join('|'), 'manifest keys');
}
function canonicalSourcePath(value: unknown): asserts value is string {
  requireInput(
    typeof value === 'string' &&
      value.length > 0 &&
      !/[:\\\0]/.test(value) &&
      !value.startsWith('/') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'noncanonical source path',
  );
}
function confinedFile(root: string, path: string): string {
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  requireInput(
    rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    'file escapes root',
  );
  requireInput(statSync(actual).isFile(), 'not a file');
  return actual;
}
// Relative attachment paths have exactly one base: the JSON report's directory.
function attachmentFile(root: string, reportPath: string, attachment: string): string {
  requireInput(attachment.length > 0 && !attachment.includes('\0'), 'empty attachment path');
  requireInput(
    !attachment.split(/[\\/]/).some((part) => part === '.' || part === '..'),
    'attachment traversal',
  );
  const windowsAbsolute = win32.isAbsolute(attachment);
  requireInput(
    !/^[a-z]:/i.test(attachment) || /^[a-z]:[\\/]/i.test(attachment),
    'drive-relative attachment',
  );
  requireInput(
    !/^[\\/]/.test(attachment) ||
      /^\\\\[^\\]+\\[^\\]+\\/.test(attachment) ||
      (sep === '/' && attachment.startsWith('/')),
    'root-relative attachment',
  );
  requireInput(
    !windowsAbsolute || sep === '\\' || isAbsolute(attachment),
    'foreign absolute attachment',
  );
  return confinedFile(root, resolve(dirname(reportPath), attachment));
}

// Both validators are required: yauzl drains actual DEFLATE output; Python checks full CRC
// and trace records. Neither extracts files, and neither can replace the other.
const ZIP_CHECK = `import io,json,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 infos=z.infolist()
 if not infos: raise ValueError("empty archive")
 names=[i.filename for i in infos]
 if len(set(names))!=len(names): raise ValueError("duplicate ZIP members")
 for i in infos:
  if i.flag_bits & 1: raise ValueError("encrypted member")
  if i.filename.startswith(("/","\\\\")) or "\\\\" in i.filename or ":" in i.filename or ".." in i.filename.split("/"): raise ValueError("unsafe member")
 bad=z.testzip()
 if bad is not None: raise ValueError("CRC failure: "+bad)
 trace=False
 for i in infos:
  data=z.read(i)
  if len(data)!=i.file_size: raise ValueError("member size mismatch")
  if i.filename.endswith(".trace"):
   rows=[json.loads(line) for line in data.decode("utf-8").splitlines() if line.strip()]
   if not rows or not all(isinstance(row,dict) for row in rows): raise ValueError("empty or malformed trace")
   context=any(row.get("type")=="context-options" and isinstance(row.get("version"),int) and row["version"]>0 for row in rows)
   events=any(row.get("type") in ("before","after","event") for row in rows)
   trace=trace or (context and events)
 if not trace: raise ValueError("nontrace archive")
 print(json.dumps({"members":len(infos)}))
`;
interface ZipEntry {
  fileName: string;
  generalPurposeBitFlag: number;
  compressionMethod: number;
  uncompressedSize: number;
}
interface ZipReader {
  entryCount: number;
  on(event: 'entry', listener: (entry: ZipEntry) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
  readEntry(): void;
  close(): void;
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream?: Readable) => void): void;
}
interface BundledYauzl {
  fromBuffer(
    bytes: Buffer,
    options: { lazyEntries: boolean; validateEntrySizes: boolean; strictFileNames: boolean },
    callback: (error: Error | null, zip?: ZipReader) => void,
  ): void;
}
// Generous trace limits, applied to actual output as well as declared sizes.
const ZIP_LIMITS = {
  compressed: 128 * 1024 * 1024,
  entries: 20_000,
  member: 512 * 1024 * 1024,
  total: 1024 * 1024 * 1024,
  milliseconds: 30_000,
};
function bundledYauzl(): BundledYauzl {
  try {
    const local = createRequire(import.meta.url);
    const test = createRequire(local.resolve('@playwright/test'));
    const playwright = createRequire(test.resolve('playwright'));
    const core = playwright.resolve('playwright-core/package.json');
    const bundle = playwright(resolve(dirname(core), 'lib/utilsBundle.js')) as {
      yauzl?: BundledYauzl;
    };
    requireInput(typeof bundle.yauzl?.fromBuffer === 'function', 'bundled yauzl unavailable');
    return bundle.yauzl;
  } catch {
    throw new Error('Viewer evidence ZIP validator unavailable: bundled yauzl is required');
  }
}
async function validateZip(bytes: Buffer) {
  const deadline = Date.now() + ZIP_LIMITS.milliseconds;
  requireInput(bytes.length <= ZIP_LIMITS.compressed, 'ZIP compressed byte limit');
  const yauzl = bundledYauzl();
  const drainedMembers = await new Promise<number>((resolveValidation, reject) => {
    let reader: ZipReader | undefined;
    let active: Readable | undefined;
    let done = false;
    let count = 0;
    let total = 0;
    const names = new Set<string>();
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      active?.destroy();
      reader?.close(); // fromBuffer forces autoClose=false.
      if (error) reject(new Error(`Viewer evidence invalid trace ZIP: ${error.message}`));
      else resolveValidation(count);
    };
    const timer = setTimeout(
      () => finish(new Error('ZIP validation deadline')),
      ZIP_LIMITS.milliseconds,
    );
    try {
      yauzl.fromBuffer(
        bytes,
        { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
        (error, zip) => {
          if (done) {
            zip?.close();
            return;
          }
          if (error || !zip) {
            finish(error ?? new Error('ZIP unavailable'));
            return;
          }
          reader = zip;
          zip.on('error', finish);
          zip.on('end', () =>
            finish(
              count === 0 || count !== zip.entryCount
                ? new Error('ZIP member count mismatch or empty ZIP')
                : undefined,
            ),
          );
          zip.on('entry', (entry) => {
            try {
              requireInput(
                ++count <= ZIP_LIMITS.entries && zip.entryCount <= ZIP_LIMITS.entries,
                'ZIP entry count limit',
              );
              const name = entry.fileName.endsWith('/')
                ? entry.fileName.slice(0, -1)
                : entry.fileName;
              canonicalSourcePath(name);
              requireInput(!names.has(name), 'duplicate ZIP member');
              names.add(name);
              requireInput((entry.generalPurposeBitFlag & (1 | 64)) === 0, 'encrypted ZIP member');
              requireInput(
                entry.compressionMethod === 0 || entry.compressionMethod === 8,
                'unsupported ZIP compression',
              );
              requireInput(
                Number.isSafeInteger(entry.uncompressedSize) &&
                  entry.uncompressedSize >= 0 &&
                  entry.uncompressedSize <= ZIP_LIMITS.member,
                'ZIP member byte limit',
              );
              zip.openReadStream(entry, (streamError, stream) => {
                if (done) {
                  stream?.destroy();
                  return;
                }
                if (streamError || !stream) {
                  finish(streamError ?? new Error('ZIP stream missing'));
                  return;
                }
                active = stream;
                let size = 0;
                stream.on('error', finish);
                stream.on('data', (chunk: Buffer) => {
                  size += chunk.length;
                  total += chunk.length;
                  if (size > ZIP_LIMITS.member || total > ZIP_LIMITS.total)
                    finish(new Error('ZIP actual byte limit'));
                });
                stream.on('end', () => {
                  if (done) return;
                  if (size !== entry.uncompressedSize) {
                    finish(new Error('ZIP member size mismatch'));
                    return;
                  }
                  stream.destroy();
                  active = undefined;
                  // Never advance before the entire current member has finished.
                  zip.readEntry();
                });
              });
            } catch (entryError) {
              finish(entryError as Error);
            }
          });
          zip.readEntry();
        },
      );
    } catch (error) {
      finish(error as Error);
    }
  });
  try {
    const remaining = deadline - Date.now();
    requireInput(remaining > 0, 'ZIP validation deadline');
    const result = execFileSync('python', ['-c', ZIP_CHECK], {
      input: bytes,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: remaining,
      maxBuffer: 1024 * 1024,
    });
    requireInput(
      record(JSON.parse(result.toString('utf8')))['members'] === drainedMembers,
      'ZIP validators disagree on member count',
    );
  } catch (error) {
    const failure = error as { code?: string; stderr?: Buffer; message?: string };
    throw new Error(
      failure.code === 'ENOENT'
        ? 'Viewer evidence ZIP validator unavailable: Python stdlib is required'
        : `Viewer evidence invalid trace ZIP: ${failure.stderr?.toString().trim() ?? failure.message}`,
    );
  }
}
// JSON.parse supplies the full grammar check; token inspection adds duplicate-key rejection.
function uniqueJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token) as string;
      const keys = stack.at(-1)!;
      requireInput(keys && !keys.has(key), 'Duplicate manifest JSON key');
      keys.add(key);
    }
  }
  return value;
}

const GENERATORS = [
  'arcane-denial',
  'fabled-passage',
  'myriad-landscape',
  'smothering-tithe',
  'war-room',
] as const;

const SCENARIO_TITLES = Object.freeze({
  'arcane-denial-viewer-draw-zero': 'Arcane Denial: next-upkeep draw 0',
  'arcane-denial-viewer-draw-two': 'Arcane Denial: next-upkeep draw 2',
  'fabled-passage-viewer-search-entry-untap':
    'Fabled Passage: search, tapped entry, and fourth-land untap',
  'myriad-landscape-viewer-enters-tapped': 'Myriad Landscape: normal land play enters tapped',
  'myriad-landscape-viewer-colorless-mana': 'Myriad Landscape: colorless mana pays a spell cost',
  'myriad-landscape-viewer-shared-type-search':
    'Myriad Landscape: grouped search enforces a shared land type',
  'smothering-tithe-viewer-pay': 'Smothering Tithe: opponent draws and pays',
  'smothering-tithe-viewer-decline': 'Smothering Tithe: opponent draws and declines',
  'war-room-viewer-dynamic-life-activation': 'War Room: dynamic commander identity life activation',
  'war-room-viewer-colorless-mana': 'War Room: colorless mana pays a spell cost',
});
const catalogKey = (spec: CatalogSpec) => JSON.stringify([spec.file, ...spec.titlePath]);
function array(value: unknown, label: string): unknown[] {
  requireInput(Array.isArray(value), `malformed ${label}`);
  return value;
}
function noErrors(value: Record<string, unknown>, required = false) {
  requireInput(value['error'] === undefined, 'execution error');
  if (required || value['errors'] !== undefined)
    requireInput(array(value['errors'], 'errors').length === 0, 'execution errors');
}
function reportTargets(
  bytes: Buffer,
  catalog: readonly CatalogSpec[],
  outputRoot: string,
  reportPath: string,
) {
  const expected = new Set(VIEWER_CATALOG.map(catalogKey));
  const expectedFiles = new Set(VIEWER_CATALOG.map((spec) => spec.file));
  requireInput(
    catalog.length === expected.size &&
      new Set(catalog.map(catalogKey)).size === expected.size &&
      catalog.every((spec) => expected.has(catalogKey(spec))),
    'catalog source parity',
  );
  const report = record(JSON.parse(bytes.toString('utf8')));
  noErrors(report, true);
  const stats = record(report['stats']);
  requireInput(
    stats['expected'] === expected.size &&
      stats['unexpected'] === 0 &&
      stats['flaky'] === 0 &&
      stats['skipped'] === 0,
    'catalog stats',
  );
  const seen = new Set<string>();
  const targets: Record<string, string> = {};
  let project: string | undefined;
  function walk(suites: unknown[], parents: string[], top: boolean, rootFile?: string) {
    for (const value of suites) {
      const suite = record(value);
      noErrors(suite);
      requireInput(
        typeof suite['title'] === 'string' && typeof suite['file'] === 'string',
        'malformed catalog suite',
      );
      requireInput(expectedFiles.has(suite['file']), 'catalog file');
      const catalogFile = top ? (suite['file'] as string) : rootFile;
      requireInput(suite['file'] === catalogFile, 'catalog suite file');
      if (top) requireInput(suite['title'] === suite['file'], 'catalog file suite title');
      const titles = top ? parents : [...parents, suite['title']];
      for (const raw of array(suite['specs'] ?? [], 'specs')) {
        const spec = record(raw);
        noErrors(spec);
        requireInput(
          typeof spec['title'] === 'string' &&
            spec['file'] === suite['file'] &&
            spec['ok'] === true,
          'catalog spec',
        );
        const key = catalogKey({ file: spec['file'], titlePath: [...titles, spec['title']] });
        requireInput(
          expected.has(key) && !seen.has(key),
          'duplicate or unexpected catalog execution',
        );
        seen.add(key);
        const tests = array(spec['tests'], 'tests');
        requireInput(tests.length === 1, 'ambiguous catalog project execution');
        const test = record(tests[0]);
        noErrors(test);
        requireInput(
          typeof test['projectName'] === 'string' &&
            test['expectedStatus'] === 'passed' &&
            test['status'] === 'expected',
          'catalog expected execution',
        );
        const identity = JSON.stringify([test['projectName'], test['projectId'] ?? '']);
        requireInput(
          test['projectId'] === undefined || typeof test['projectId'] === 'string',
          'catalog projectId',
        );
        project ??= identity;
        requireInput(project === identity, 'ambiguous catalog project execution');
        const results = array(test['results'], 'results');
        requireInput(results.length === 1, 'retried catalog execution');
        const result = record(results[0]);
        noErrors(result, true);
        requireInput(
          result['status'] === 'passed' && result['retry'] === 0,
          'catalog first-attempt execution',
        );
        const attachments = array(result['attachments'], 'attachments').map(record);
        for (const attachment of attachments) {
          requireInput(
            typeof attachment['name'] === 'string' && typeof attachment['contentType'] === 'string',
            'malformed attachment',
          );
          if (attachment['path'] !== undefined) {
            requireInput(typeof attachment['path'] === 'string', 'malformed attachment path');
            attachmentFile(outputRoot, reportPath, attachment['path']);
          }
        }
        const id =
          Object.entries(SCENARIO_TITLES).find(
            ([, title]) => titles.length === 0 && title === spec['title'],
          )?.[0] ?? key;
        {
          const traces = attachments.filter((a) => a['name'] === 'trace');
          requireInput(
            traces.length === 1 &&
              traces[0]!['contentType'] === 'application/zip' &&
              typeof traces[0]!['path'] === 'string' &&
              traces[0]!['body'] === undefined,
            'missing or ambiguous trace attachment',
          );
          targets[id] = traces[0]!['path'] as string;
        }
      }
      walk(array(suite['suites'] ?? [], 'suites'), titles, false, catalogFile);
    }
  }
  walk(array(report['suites'], 'suites'), [], true);
  requireInput(
    seen.size === expected.size && Object.keys(targets).length === expected.size,
    'missing catalog execution',
  );
  return targets;
}

// Authored-source traversal is intentionally separate from the emitted-JS test discovery.
// Value imports/reexports are a conservative superset, including unused runtime exports.
// Each discovery owns these caches. Node's installed resolver runs in a new process,
// because createRequire alone shares process-global package/realpath resolution caches.
const INSTALLED_RESOLVER = `const fs=require('node:fs'),{createRequire}=require('node:module');
if(!process.versions.node||process.versions.bun)throw Error('Node resolver required');
const edges=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(edges.map(([importer,specifier])=>{
 const path=createRequire(importer).resolve(specifier);
 return {path,realpath:fs.realpathSync(path)};
})));`;
interface DiscoveryState {
  parsed: Map<string, ts.SourceFile>;
  resolutionCache: ts.ModuleResolutionCache;
  installed: Map<string, { path: string; realpath: string }>;
}
/** Parsed sources, keyed by repository path and content hash. Bounded by distinct file contents. */
const parsedSources = new Map<string, ts.SourceFile>();
function discoveryState(root: string): DiscoveryState {
  return {
    parsed: new Map(),
    resolutionCache: ts.createModuleResolutionCache(root, (path) => path),
    installed: new Map(),
  };
}
function installedResolutions(state: DiscoveryState, requests: [string, string][]) {
  const missing = [
    ...new Map(requests.map((edge) => [JSON.stringify(edge), edge])).values(),
  ].filter((edge) => !state.installed.has(JSON.stringify(edge)));
  if (!missing.length) return;
  try {
    // Use available Node on PATH under both Node and Bun; process.execPath can be Bun.
    // Fixed script/argv, stdin data, no shell, no module execution or global cache mutation.
    const results: unknown = JSON.parse(
      execFileSync('node', ['--input-type=commonjs', '-e', INSTALLED_RESOLVER], {
        input: JSON.stringify(missing),
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    requireInput(Array.isArray(results) && results.length === missing.length, 'resolver response');
    for (let i = 0; i < missing.length; i++) {
      const result = record(results[i]);
      requireInput(
        typeof result['path'] === 'string' && typeof result['realpath'] === 'string',
        'resolver path response',
      );
      state.installed.set(JSON.stringify(missing[i]), {
        path: result['path'],
        realpath: result['realpath'],
      });
    }
  } catch {
    throw new Error(
      'Viewer evidence input: fresh installed Node resolution unavailable or unresolved',
    );
  }
}
interface GeneratorDiscovery {
  files: string[];
  edges: string[][];
  data: string[][];
}
function sourceIdentity(root: string, paths: string[]): string {
  return JSON.stringify(
    [...paths].sort().map((path) => {
      canonicalSourcePath(path);
      return [path, resolve(root, path), confinedFile(root, resolve(root, path))];
    }),
  );
}
export function discoverGeneratorSourceFiles(repoRoot: string, generatorPath: string): string[] {
  return discoverGeneratorSources(repoRoot, generatorPath, discoveryState(repoRoot)).files;
}
function discoverGeneratorSources(
  repoRoot: string,
  generatorPath: string,
  state: DiscoveryState,
): GeneratorDiscovery {
  const { parsed, resolutionCache } = state;
  const root = realpathSync(repoRoot);
  const seen = new Set<string>();
  const inputs = new Set<string>(['.prettierrc']); // resolveConfig() consumed by writeReport.
  const edges: string[][] = [];
  const data: string[][] = [];
  const pending = [generatorPath];
  const deferred: { edge: [string, string]; resume: () => void }[] = [];
  while (pending.length || deferred.length) {
    if (!pending.length) {
      const batch = deferred.splice(0);
      installedResolutions(
        state,
        batch.map((item) => item.edge),
      );
      for (const item of batch) item.resume();
      continue;
    }
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    canonicalSourcePath(path);
    const absolute = confinedFile(root, resolve(root, path));
    seen.add(path);
    if (extname(path) === '.json') continue;
    let source = parsed.get(path);
    if (!source) {
      // Every discovery pass re-reads the same sources; parsing is the expensive part. Keying on
      // the bytes keeps drift detection exact: an edited file gets a fresh AST.
      const text = readFileSync(absolute, 'utf8');
      const key = `${path}\0${hash(Buffer.from(text))}`;
      source = parsedSources.get(key);
      if (!source) {
        source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
        parsedSources.set(key, source);
      }
      parsed.set(path, source);
    }
    const ast = source;
    const fileReaders = new Set(['readFileSync', 'readFile']);
    const fileNamespaces = new Set<string>();
    for (const statement of ast.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].includes(
          statement.moduleSpecifier.text,
        )
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) fileNamespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) {
          if (
            ['readFileSync', 'readFile'].includes(element.propertyName?.text ?? element.name.text)
          )
            fileReaders.add(element.name.text);
        }
    }
    function dependency(specifier: string) {
      if (!specifier.startsWith('.') && !specifier.startsWith('@mtg/')) return;
      const workspace = specifier.startsWith('@mtg/');
      const installed = state.installed.get(JSON.stringify([absolute, specifier]));
      if (workspace && !installed) {
        deferred.push({ edge: [absolute, specifier], resume: () => dependency(specifier) });
        return;
      }
      const resolved = workspace
        ? undefined
        : ts.resolveModuleName(
            specifier,
            absolute,
            {
              moduleResolution: ts.ModuleResolutionKind.Bundler,
              resolveJsonModule: true,
            },
            ts.sys,
            resolutionCache,
          ).resolvedModule;
      requireInput(
        (workspace ? installed : resolved) &&
          !(installed?.path ?? resolved?.resolvedFileName)?.endsWith('.d.ts'),
        `unresolved runtime import: ${path}: ${specifier}`,
      );
      const resolvedPath = resolve(installed?.path ?? resolved!.resolvedFileName);
      const actual = confinedFile(root, resolvedPath);
      requireInput(
        !installed || installed.realpath === actual,
        'installed resolution identity drifted',
      );
      const local = relative(root, actual).split(sep).join('/');
      requireInput(!local.split('/').includes('node_modules'), 'nonlocal workspace import');
      pending.push(local);
      edges.push([
        generatorPath,
        absolute,
        specifier,
        workspace ? 'installed-node-createRequire' : 'typescript-bundler',
        resolvedPath,
        actual,
      ]);
      if (workspace) {
        // Find actual owning metadata, never infer packages/<name> from path spelling.
        let directory = dirname(actual);
        while (!ts.sys.fileExists(resolve(directory, 'package.json'))) {
          const parent = dirname(directory);
          requireInput(
            parent !== directory && directory !== root,
            'missing owning package metadata',
          );
          directory = parent;
        }
        const metadata = confinedFile(root, resolve(directory, 'package.json'));
        const name = specifier.split('/').slice(0, 2).join('/');
        requireInput(
          record(JSON.parse(readFileSync(metadata, 'utf8')))['name'] === name,
          'workspace owning package name',
        );
        inputs.add(relative(root, metadata).split(sep).join('/'));
        edges.push([
          generatorPath,
          absolute,
          specifier,
          'owning-package',
          resolve(directory, 'package.json'),
          metadata,
          name,
        ]);
      }
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const erased =
          clause?.isTypeOnly ||
          (clause &&
            !clause.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every((element) => element.isTypeOnly));
        if (!erased && ts.isStringLiteral(node.moduleSpecifier))
          dependency(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
        const erased =
          node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((element) => element.isTypeOnly);
        if (!erased && ts.isStringLiteral(node.moduleSpecifier))
          dependency(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node)) {
        const name = node.expression.getText(ast);
        if (name === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const specifier = node.arguments[0];
          requireInput(
            specifier && ts.isStringLiteralLike(specifier),
            `unresolved dynamic runtime import: ${path}`,
          );
          dependency(specifier.text);
        }
        const fileRead =
          fileReaders.has(name) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            fileNamespaces.has(node.expression.expression.getText(ast)) &&
            ['readFileSync', 'readFile'].includes(node.expression.name.text));
        if (fileRead && path !== 'scripts/card-evidence-input.ts') {
          const argument = node.arguments[0];
          // Generators hash their declared SOURCE_FILES and validated/legacy trace paths.
          // Only this specific fingerprint function has a deliberately dynamic file argument.
          let parent: ts.Node | undefined = node.parent;
          while (
            parent &&
            !ts.isFunctionDeclaration(parent) &&
            !ts.isArrowFunction(parent) &&
            !ts.isSourceFile(parent)
          )
            parent = parent.parent;
          const functionName =
            parent && ts.isFunctionDeclaration(parent)
              ? parent.name?.text
              : parent && ts.isArrowFunction(parent) && ts.isVariableDeclaration(parent.parent)
                ? parent.parent.name.getText(ast)
                : undefined;
          const fingerprint =
            path === generatorPath &&
            functionName === 'fileSha256' &&
            argument &&
            ts.isIdentifier(argument) &&
            argument.text === 'path';
          if (fingerprint) return;
          const literal =
            argument &&
            ts.isCallExpression(argument) &&
            argument.expression.getText(ast) === 'resolve' &&
            argument.arguments.length === 1
              ? argument.arguments[0]
              : argument;
          requireInput(
            literal && ts.isStringLiteralLike(literal),
            `unresolved consumed data path: ${path}`,
          );
          canonicalSourcePath(literal.text);
          const input = resolve(root, literal.text);
          const actual = confinedFile(root, input);
          data.push([generatorPath, absolute, name, String(node.pos), literal.text, input, actual]);
          inputs.add(literal.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  // The helper reads externally supplied manifest/report/trace bytes and discovered sources.
  // These inputs are governed by the loader; they are not pinned scenario data.
  return { files: [...new Set([...seen, ...inputs])].sort(), edges, data };
}

export function getViewerEvidenceSourceFiles(repoRoot: string): string[] {
  return discoverViewerEvidenceSources(repoRoot).files;
}
function discoverViewerEvidenceSources(repoRoot: string) {
  const union = new Set<string>();
  const root = realpathSync(repoRoot);
  const state = discoveryState(root);
  const closures: { generator: string; files: string[]; edges: string[][]; data: string[][] }[] =
    [];
  for (const card of GENERATORS) {
    const source = readFileSync(resolve(repoRoot, `scripts/generate-${card}-evidence.ts`), 'utf8');
    const list = source.match(/const SOURCE_FILES = \[([\s\S]*?)\] as const;/)?.[1];
    if (!list || list.replace(/'[^']+'\s*,?/g, '').trim()) throw new Error('Malformed source list');
    const paths = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    if (new Set(paths).size !== paths.length) throw new Error('Duplicate source list entry');
    const consumed = discoverGeneratorSources(
      repoRoot,
      `scripts/generate-${card}-evidence.ts`,
      state,
    );
    requireInput(
      consumed.files.every((path) => paths.includes(path)),
      `incomplete generator source binding: ${card}; missing: ${consumed.files.filter((path) => !paths.includes(path)).join(', ')}`,
    );
    const order = (a: string[], b: string[]) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    closures.push({
      generator: card,
      files: consumed.files,
      edges: consumed.edges.sort(order),
      data: consumed.data.sort(order),
    });
    for (const path of paths) union.add(path);
  }
  // Generator imports cannot discover Vue imports or the separately launched server. Bind
  // the complete owned runtime input trees conservatively, including new files, rather than
  // allowing an unlisted component/session dependency to leave an old receipt current.
  const runtimeRoots = [
    'packages/engine/src',
    'packages/bot/src',
    'packages/server/src',
    'packages/shared/src',
    'apps/web/src',
    'apps/web/public',
    'apps/web/e2e',
  ];
  const runtimeRouting: string[][] = [];
  const visitedRuntimeDirectories = new Set<string>();
  function collect(directory: string): void {
    if (!existsSync(resolve(root, directory))) return;
    const actualDirectory = realpathSync(resolve(root, directory));
    const localDirectory = relative(root, actualDirectory).split(sep).join('/');
    requireInput(
      localDirectory !== '' &&
        localDirectory !== '..' &&
        !localDirectory.startsWith('../') &&
        !isAbsolute(localDirectory),
      `runtime directory escapes repository: ${directory}`,
    );
    runtimeRouting.push([directory, localDirectory]);
    if (visitedRuntimeDirectories.has(actualDirectory)) return;
    visitedRuntimeDirectories.add(actualDirectory);
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      const metadata = entry.isSymbolicLink() ? statSync(resolve(root, path)) : entry;
      if (metadata.isDirectory()) collect(path);
      else if (metadata.isFile()) {
        const actual = confinedFile(root, resolve(root, path));
        const local = relative(root, actual).split(sep).join('/');
        runtimeRouting.push([path, local]);
        union.add(local);
      } else requireInput(false, `unsupported runtime input: ${path}`);
    }
  }
  for (const directory of runtimeRoots) collect(directory);
  for (const path of [
    'package.json',
    'bun.lock',
    'playwright.config.ts',
    'apps/web/package.json',
    'apps/web/index.html',
    'apps/web/vite.config.ts',
    'packages/server/package.json',
  ])
    if (existsSync(resolve(root, path))) {
      confinedFile(root, resolve(root, path));
      union.add(path);
    }
  const files = [...union].sort();
  // Strings privately capture immutable structured identities; callers cannot replace tuples.
  return {
    files,
    identity: JSON.stringify({
      closures,
      runtimeRouting: runtimeRouting.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
      sources: JSON.parse(sourceIdentity(root, files)),
    }),
  };
}

export async function loadViewerEvidence(
  paths: ViewerInputPaths,
  options: { repoRoot: string; sourceFiles: readonly string[]; catalog: readonly CatalogSpec[] },
): Promise<ValidatedViewerEvidence> {
  const manifestBytes = readFileSync(paths.sourceManifestPath);
  const manifest = record(uniqueJson(manifestBytes.toString('utf8')));
  exactKeys(manifest, ['schemaVersion', 'testedTree', 'reportSha256', 'files']);
  requireInput(manifest['schemaVersion'] === 1, 'manifest schemaVersion');
  requireInput(
    typeof manifest['testedTree'] === 'string' && /^[0-9a-f]{40}$/.test(manifest['testedTree']),
    'manifest tree',
  );
  requireInput(
    typeof manifest['reportSha256'] === 'string' && /^[0-9a-f]{64}$/.test(manifest['reportSha256']),
    'manifest report hash',
  );
  const tree = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD^{tree}'], {
    cwd: options.repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  if (manifest['testedTree'] !== tree) throw new Error('Tested tree differs from actual Git tree');
  const reportBytes = readFileSync(paths.reportPath);
  requireInput(hash(reportBytes) === manifest['reportSha256'], 'report bytes drifted');
  const discovery = discoverViewerEvidenceSources(options.repoRoot);
  const required = discovery.files;
  requireInput(
    new Set(options.sourceFiles).size === options.sourceFiles.length &&
      JSON.stringify([...options.sourceFiles].sort()) === JSON.stringify(required),
    'incomplete source union',
  );
  requireInput(Array.isArray(manifest['files']), 'manifest files');
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  const root = realpathSync(options.repoRoot);
  for (const entry of manifest['files']) {
    const item = record(entry);
    exactKeys(item, ['path', 'sha256']);
    canonicalSourcePath(item['path']);
    requireInput(
      typeof item['sha256'] === 'string' && /^[0-9a-f]{64}$/.test(item['sha256']),
      'manifest source hash',
    );
    requireInput(!Object.hasOwn(files, item['path']), 'Duplicate manifest source path');
    const path = confinedFile(root, resolve(root, item['path']));
    requireInput(
      hash(readFileSync(path)) === item['sha256'],
      `source bytes drifted: ${item['path']}`,
    );
    files[item['path']] = item['sha256'];
  }
  requireInput(
    required.every((path) => Object.hasOwn(files, path)),
    'manifest missing source',
  );
  // Capture now, before asynchronous ZIP drainage, from the validated initial discovery.
  const capturedSourceIdentity = sourceIdentity(root, Object.keys(files));
  const outputRoot = realpathSync(paths.outputRoot);
  requireInput(statSync(outputRoot).isDirectory(), 'output root is not a directory');
  const traces: Record<string, { path: string; sha256: string }> = {};
  const validated = new Map<string, string>();
  for (const [id, attachment] of Object.entries(
    reportTargets(reportBytes, options.catalog, outputRoot, paths.reportPath),
  )) {
    const path = attachmentFile(outputRoot, paths.reportPath, attachment);
    requireInput(extname(path).toLowerCase() === '.zip', 'trace is not a .zip file');
    if (!validated.has(path)) {
      requireInput(statSync(path).size <= ZIP_LIMITS.compressed, 'ZIP compressed byte limit');
      // Privately own bytes: callers/mocked filesystem buffers cannot mutate validation input.
      const bytes = Buffer.from(readFileSync(path));
      await validateZip(bytes);
      validated.set(path, hash(bytes));
    }
    traces[id] = { path, sha256: validated.get(path)! };
  }
  for (const trace of Object.values(traces)) Object.freeze(trace);
  const context: ValidatedViewerEvidence = Object.freeze({
    [validatedBrand]: true as const,
    testedTree: manifest['testedTree'],
    reportSha256: manifest['reportSha256'],
    files: Object.freeze(files),
    traces: Object.freeze(traces),
  });
  contexts.set(context, {
    repoRoot: root,
    outputRoot,
    paths: {
      reportPath: resolve(paths.reportPath),
      outputRoot: resolve(paths.outputRoot),
      sourceManifestPath: resolve(paths.sourceManifestPath),
    },
    manifestSha256: hash(manifestBytes),
    discoveryIdentity: discovery.identity,
    sourceIdentity: capturedSourceIdentity,
  });
  validateCurrentEvidenceSources(context, root);
  return context;
}

export async function loadGeneratorViewerEvidence(
  argv: readonly string[],
  repoRoot = process.cwd(),
) {
  const paths = parseViewerEvidenceOptions(argv);
  return paths === undefined
    ? undefined
    : loadViewerEvidence(paths, {
        repoRoot,
        sourceFiles: getViewerEvidenceSourceFiles(repoRoot),
        catalog: VIEWER_CATALOG,
      });
}

export function parseViewerEvidenceOptions(argv: readonly string[]): ViewerInputPaths | undefined {
  if (argv.length === 0) return undefined;
  const flags = new Map<string, keyof ViewerInputPaths>([
    ['--viewer-report', 'reportPath'],
    ['--viewer-output', 'outputRoot'],
    ['--viewer-source-manifest', 'sourceManifestPath'],
  ]);
  const paths: Partial<ViewerInputPaths> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags.get(argv[i]!);
    if (!key || key in paths) throw new Error('Unknown or duplicate viewer flag');
    const value = argv[i + 1];
    if (!value?.trim() || value['startsWith']('--')) throw new Error('Missing viewer flag value');
    paths[key] = value;
  }
  if (!paths.reportPath || !paths.outputRoot || !paths.sourceManifestPath)
    throw new Error('Viewer inputs require the complete trio');
  return paths as ViewerInputPaths;
}

// Frozen machine-report identities; independently checked against the spec AST in unit tests.
export const VIEWER_CATALOG: readonly CatalogSpec[] = [
  { file: 'card-test-lab.spec.ts', titlePath: ['Madame Null: pay life for the entering creature'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Madame Null: decline the life payment'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Madame Null: skip an unaffordable life payment'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Madame Null: keep separate blinked incarnations'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Madame Null: read the departed creature's power"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Marchesa: return your dead creature'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Marchesa: return an opponent-owned creature'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Marchesa: ignore a creature without a +1/+1 counter'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Marchesa: ignore an opponent-controlled creature'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Marchesa: skip the card exiled by Bojuka Bog'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Easy Pickings: cast an Adventure commander from the command zone'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Mosswort Bridge: cast a hidden Adventure spell face'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Mosswort Bridge: cast a hidden permanent on the spell stack'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Mosswort Bridge: a hidden land still needs a land play'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Tribute Mage: exact mana-value search'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Gev, Scaled Scorch: ward — pay 2 life'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Nightscape Familiar: regenerate survives destruction'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Thran Vigil: artifact leaves your graveyard'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Harmonic Prodigy: Shaman trigger fires twice'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Swords to Plowshares: exile and gain life'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Go for the Throat: destroy a nonartifact creature'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Blossoming Defense: pump and hexproof'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Bojuka Bog: exile the targeted graveyard'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Citywide Bust: destroy toughness 4 or greater'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Defile: -1/-1 per Swamp you control'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Unleash Fury: double target power'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Aura Mutation: destroy enchantment, make Saprolings'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Mutilate: -1/-1 per Swamp, all creatures'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Their Name Is Death: destroy nonartifact creatures'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Chain Reaction: damage equal to creature count'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Collective Unconscious: draw for your creatures'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Camaraderie: life, cards, and +1/+1'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Shamanic Revelation: draw creatures, life for power 4'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Flayed One: mill three and lifelink'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Night Scythe: create a Necron Warrior'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Game Trail: reveal a Forest, enter untapped'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Fortified Village: reveal a Plains, enter untapped'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Shineshadow Snarl: reveal a Swamp, enter untapped'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Magmaquake: X damage, spare flying'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Hunter's Prowess: pump and trample"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Royal Warden: two tapped Necron Warriors'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Provoke the Trolls: damage then pump'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Hoard-Smelter Dragon: destroy artifact and pump'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Loaming Shaman: shuffle a graveyard card'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Chronomancer: sacrifice an artifact, draw'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Akoum Hellkite: Mountain landfall deals 2'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Dawn of Hope: create a lifelink Soldier'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Rootborn Defenses: grant indestructible'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Trostani Discordant: two lifelink Soldiers'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Felidar Retreat: landfall Cat Beast'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Hornet Nest: damage makes Insects'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Slate of Ancestry: discard and draw for creatures'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Canoptek Scarab Swarm: exile graveyard, make Insects'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Great Oak Guardian: pump and untap P2 creatures'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Frostboil Snarl: reveal an Island, enter untapped'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Vineglimmer Snarl: reveal a Forest, enter untapped'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Stroke of Midnight: destroy nonland, make a Human'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Generous Gift: destroy Lab Ox, make an Elephant'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Boros Garrison: bounce Forest, enter tapped'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Orzhov Basilica: bounce Forest, enter tapped'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Pia and Kiran Nalaar: two flying Thopters'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Crackling Doom: opponents take 2, P2 sacs Lab Ox'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Rakdos Carnarium: bounce Forest, enter tapped'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Whirler Rogue: two flying Thopters'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Reckless Fireweaver: artifact ETB pings opponents'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Spit Flame: 4 damage to Lab Ox'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sai, Master Thopterist: artifact makes a Thopter'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Secret Rendezvous: you and P2 each draw three'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Demanding Dragon: 5 damage when P2 has no creature'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Cryptothrall: your other artifact creature has hexproof'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Boros Charm: 4 damage to P2'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Rakdos Charm: destroy Wrong-MV Artifact'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Steel Hellkite: +1/+0 until end of turn'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Rogue Refiner: draw a nonland and get two energy'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Whirler Virtuoso: three energy makes a Thopter'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Ajani, Caller of the Pride: +1 counter on Lab Ox'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Terror of the Peaks: entering Bear deals 2 to P2'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Aetherwind Basker: +1/+1 until end of turn'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Zopandrel: indestructible counter grants indestructible'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Arcane Denial: next-upkeep draw 0'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Arcane Denial: next-upkeep draw 2'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Smothering Tithe: opponent draws and pays'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Smothering Tithe: opponent draws and declines'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Fabled Passage: search, tapped entry, and fourth-land untap'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Myriad Landscape: normal land play enters tapped'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'land confirmation',
      'a single legal land submits from its hand card when both confirm settings are off',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['land confirmation', 'confirm passes and lands keeps the review step'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['land confirmation', 'skip confirm submits the land once'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'land confirmation',
      'the playable list names the land and plays it like its hand card',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['land confirmation', 'passing with a playable land asks before passing'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['land confirmation', 'the land drop reminder can be turned off'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'land confirmation',
      'confirm passes and lands still reviews when skip confirm is also on',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Myriad Landscape: colorless mana pays a spell cost'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Myriad Landscape: grouped search enforces a shared land type'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['War Room: dynamic commander identity life activation'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['War Room: colorless mana pays a spell cost'] },
  // Coverage PR01 (docs/plans/card-coverage-chunks.md).
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Forum of Amity: surveil 1 through the normal activation'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Attune with Aether: reveal a basic land, then get two energy'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Beacon of Unrest: reanimate a creature card, shuffle Beacon away'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Canoptek Spyder: a Vehicle entering draws a card'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Canoptek Wraith: pay, sacrifice, and fetch same-name basics'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Conjurer's Closet: blink a creature at your end step"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Harvest Season: search a basic per tapped creature'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Land Tax: reveal three basics at your upkeep'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Mordant Dragon: redirect combat damage to that player's creature"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Necron Deathmark: destroy up to one creature, mill three'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Plasmancer: enters and reveals a basic Swamp'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sylvan Reclamation: exile up to two artifacts and/or enchantments'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sylvan Reclamation: basic landcycling reveals a basic land'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Thunderfoot Baloth: lieutenant pumps your creatures'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Tomb Fortress: mill four, then return a creature card'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Voice of Many: draw for each opponent with fewer creatures'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Foe-Razer Regent: fight on entry, grow at the end step'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Hunting Wilds: kicked, two Forests become 3/3 haste creatures'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Loran of the Third Path: destroy up to one artifact or enchantment'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Loran of the Third Path: you and target opponent each draw'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Rishkar, Peema Renegade: two counters, then countered creatures tap for G'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Vastwood Surge: kicked, two basics and counters on your creatures'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Frontier Siege: Khans adds {G}{G} at your next main phase'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Frontier Siege: Dragons lets an entering flier fight'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Kairi, the Swirling Sky: dies, bounce up to total mana value 6'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Kairi, the Swirling Sky: dies, mill six and return a spell'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Will of the Mardu: choose both while you control a commander'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Aether Channeler: return another target nonland permanent'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Aether Channeler: create a 1/1 white Bird with flying'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Aether Channeler: draw a card'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Return to Nature: destroy target enchantment'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Return to Nature: exile target card from a graveyard'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Mystic Sanctuary: enters untapped and returns an instant'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Brokers Hideout: sacrifice it, then search for a basic'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sweet-Gum Recluse: counters on creatures that entered this turn'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sweet-Gum Recluse: flash in response, cascade into a cheaper spell'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sweet-Gum Recluse: reach blocks a flier'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Kogla, the Titan Ape: fight up to one creature on entry'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Kogla, the Titan Ape: bounce a Human, then attack'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Public zones: reanimate an opponent’s creature'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Chains of Custody: attach before the entry trigger'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Phyrexian Tower: use the Elf before sacrificing it'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Queen Allenal: plain and lifelink Soldiers stay distinct'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Twinflame Tyrant: double damage from your spell'],
  },
  // Coverage PR02 (docs/plans/card-coverage-chunks.md).
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Retrofitter Foundry: Servo, Thopter, then Construct'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Aether Hub: enter for energy, then pay it for green'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Aether Hub: colorless mana with no energy'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Solar Transformer: enter tapped for energy, then pay it for red'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Solar Transformer: colorless mana with no energy'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Bespoke Battlewagon: tap for energy, then crew 4'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Bespoke Battlewagon: pay four energy to animate, then draw'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Bespoke Battlewagon: pay two energy to tap P2's creature"],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Endless Atlas: three Forests unlock the draw'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Endless Atlas: two Forests and an Island do not unlock it'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sceptre of Eternal Glory: three Forests unlock {B}{B}{B}'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sceptre of Eternal Glory: mixed lands give one mana'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Weathered Wayfarer: behind on lands, reveal a land'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Weathered Wayfarer: equal lands do not unlock it'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Idol of Oblivion: make a token, then draw'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Idol of Oblivion: sacrifice it for a 10/10 Eldrazi'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Mistveil Plains: put a graveyard card on the bottom'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Mistveil Plains: one white permanent does not unlock it'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Carrion Feeder: sacrifice another creature, then itself'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ["Carrion Feeder: it can't block"] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Nullmage Shepherd: tap itself and three others to destroy an enchantment'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sage of Fables: a Wizard enters with a counter, then pay it to draw'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Illuminor Szeras: sacrifice a creature for black mana'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Peema Trailblazer: exhaust for counters and cards'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Peema Trailblazer: combat damage gives energy'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Soul-Guide Lantern: enter and exile a card from P2's graveyard"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Soul-Guide Lantern: sacrifice it to exile each opponent's graveyard"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Soul-Guide Lantern: pay {1} and sacrifice it to draw'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Ghost Ark: crew it, then unearth an artifact creature'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Flare of Denial: sacrifice a blue creature to counter P2's spell"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Flare of Malice: sacrifice a black creature; P2 loses its biggest creature'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Blasphemous Edict: pay {B} with thirteen creatures out'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Dread Return: flash it back by sacrificing three creatures'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Raffine's Guidance: cast it from the graveyard for {2}{W}"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Their Number Is Legion: cast it from the graveyard with X=2'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Anrakyr the Traveller: attack, then cast an artifact for life'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Toxic Deluge: pay 2 life for -2/-2'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Conclave Tribunal: convoke with three creatures'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Hour of Reckoning: three Plains and four convoked creatures'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Killian, Ink Duelist: a {2}{R} bolt at a creature for {R}'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Dragonkin Berserker: attack, then Boast for {2}{R}'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Convergence of Dominion: Unearth {3} for {1}'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Kogla and Yidaro: enter and fight P2's Lab Ox"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Kogla and Yidaro: discard it to destroy P2's artifact"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Changing Loyalty: replicate once onto both of P2's creatures"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Changing Loyalty: enchant P2's Lab Ox, destroy it, and take it"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Grim Haruspex: cast it face down, turn it face up, then draw'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Dream Devourer: foretell a card for {2}'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Dream Devourer: cast a foretold card for {R}'],
  },
  ...(
    JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../packages/engine/tests/fixtures/target-untap-oracle.json'),
        'utf8',
      ),
    ) as { cards: { card: { name: string } }[] }
  ).cards.map(({ card }) => ({
    file: 'card-test-lab.spec.ts',
    titlePath: [`${card.name}: affect and untap one target`],
  })),
  { file: 'card-test-lab.spec.ts', titlePath: ['Faerie Guidemother: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Gift of the Fae: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Tuinvale Treefolk: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Oaken Boon: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Two-Headed Hunter: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Twice the Rage: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Foulmire Knight: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Profane Insight: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['An Unexpected Party: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['At the Door: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Obyra's Attendants: play the ordinary front"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Desperate Parry: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Garenbrig Carver: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Shield's Might: cast the selected spell face"] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Lindblum, Industrial Regency: play the ordinary front'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Mage Siege: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Tempest Hart: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Scan the Clouds: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Imodane's Recruiter: play the ordinary front"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Train Troops: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Embereth Shieldbreaker: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Battle Display: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Gl\u00f3in the Mighty: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Easy Pickings: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Shepherd of the Flock: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Usher to Safety: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Sagu Wildling: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Roost Seek: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Silverflame Squire: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['On Alert: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Oakhame Ranger: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Bring Back: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Realm-Cloaked Giant: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Cast Off: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Frolicking Familiar: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Blow Off Steam: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Lonesome Unicorn: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Rider in Need: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Topaz Dragon: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Entropic Cloud: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Horn of Valhalla: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Ysgard's Call: cast the selected spell face"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Minecart Daredevil: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Ride the Rails: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Curious Pair: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Treats to Share: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Gingerbread Hunter: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Puny Snack: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Bilbo Baggins, Burglar: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Take a Glance: cast the selected spell face'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Smaug, the Great Calamity: play the ordinary front'],
  },
  { file: 'card-test-lab.spec.ts', titlePath: ['Spew Flame: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Young Blue Dragon: play the ordinary front'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Sand Augury: cast the selected spell face'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Counterspell: counter your own spell'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Counterspell: counter an opponent's spell"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Negate: counter your own spell'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Negate: counter an opponent's spell"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Mana Leak: counter your own spell'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Mana Leak: counter an opponent's spell"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Stubborn Denial: counter your own spell'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Stubborn Denial: counter an opponent's spell"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Force of Negation: counter your own spell'] },
  { file: 'card-test-lab.spec.ts', titlePath: ["Force of Negation: counter an opponent's spell"] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Cyclonic Rift: one normal target'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Cyclonic Rift: overload without targets'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Vandalblast: one normal target'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Vandalblast: overload without targets'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Damn: one normal target'] },
  { file: 'card-test-lab.spec.ts', titlePath: ['Damn: overload without targets'] },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Profane Insight: cast the spell face from temporary exile'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Roost Seek: cast the spell face from temporary exile'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Marchesa: return creatures after simultaneous deaths'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Triarch Praetorian: unearth it to draw two cards'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Canoptek Tomb Sentinel: unearth it to exile P2's Lab Ox"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Glen Elendra Archmage: counter P3's spell, then persist"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Flayer of the Hatebound: destroy it, undying, deal 5 to P2'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Kambal, Consul of Allocation: tax P2's noncreature spell"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Gleeful Arsonist: burn P2 for casting, then undying'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Shard of the Nightbringer: cast it to drain half of P2's life"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sautekh Immortal: two creatures died this turn, so it enters as a 4/4'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Iron Apprentice: it dies and its +1/+1 counter moves to Lab Bird'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Vigean Graftmage: graft a counter, then untap a creature that has one'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Pensive Professor: Increment grows it, then the counter draws a card'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Elite Scaleguard: bolster the smallest creature, then tap a blocker as it attacks',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Forgotten Ancient: grow when a spell is cast, then move counters at your upkeep'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['The Thing: four counters after a noncreature spell, then pay to double counters'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Lockjaw, Slobbering Teleporter: a noncreature spell grows it and makes two creatures unblockable',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Belladonna Took: three tokens give life, then a card, then a counter on each creature',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Rumor Gatherer: scry 1, then draw instead on the second creature, then scry again',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Crystal, Inhuman Princess: a two-color spell deals 2 to each opponent'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Call Forth the Tempest: damage equals the mana value of your other spells this turn',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['First Family: draw and gain life for each color among your permanents and spells'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Unbreakable Formation: cast in your main phase, your creatures also get counters and vigilance',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'The Fantasticar: become a creature, then sacrifice it on your fourth noncreature spell',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Kutzil, Malamet Exemplar: one grown creature connecting draws a card, and opponents cannot cast spells',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Finneas, Ace Archer: attacking grows your tokens and Rabbits, and total power 10 draws a card',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Captain America, Skybound: battalion grows each attacker and makes them indestructible',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Aetheric Amplifier: double the counters on a target permanent'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Cranial Plating: equip, then move it with {B}{B}'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Cranial Plating: attach it with a spell on the stack, and its bonus tracks your artifacts',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Mask of Memory: equip it, connect, then draw two and discard a card'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Resurrection Orb: equip a stolen creature, gain life, lose it, and it returns home',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Sunforger: equip it, then unattach it to cast a red instant from your library for free',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Screams from Within: its creature dies and it returns onto a hexproof opposing creature',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Ghoulish Impetus: its creature dies and it returns at the next end step'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Ghoulish Impetus: the goaded creature must attack, an unenchanted one may stay home',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Ghoulish Impetus: P2’s goaded creature cannot attack you, their other creature can',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Gift of Immortality: the creature returns to its owner, then the Aura returns onto it',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Ajani's Chosen: an Aura you cast moves onto the Cat it makes"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      "Ajani's Chosen: a non-Aura enchantment you cast makes a Cat with nothing to attach",
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Shielded by Faith: it moves onto a creature that enters and keeps it indestructible',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Shielded by Faith: an opponent’s creature entering offers you the attach'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Forum Filibuster: at your upkeep the Inkling gets an Aura from your graveyard'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Forum Filibuster: at your upkeep the Inkling gets an Equipment from your graveyard',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      "Karametra's Favor: draw a card, then tap the enchanted creature for mana to cast a spell",
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Redemption Arc: enchant your creature, then pay {1}{W} to exile it with no target',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Redemption Arc: Lab Doom cannot destroy the creature, which must attack'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Redemption Arc: P2’s goaded creature cannot attack you, their other creature can'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Fallen Ideal: sacrifice for a pump, then sacrifice the creature to get the Aura back',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Fallen Ideal: the enchanted creature flies over Lab Ox and attacks unblocked'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Kor Spiritdancer: cast an Aura on it, draw a card, and it grows by +2/+2 for the Aura',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Kor Spiritdancer: a second attached Aura adds another +2/+2 to the pump'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Hateful Eidolon: your Aura on an opponent’s creature, then it dies and you draw'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Hateful Eidolon: two of your Auras on a creature that dies draw you two cards'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Hateful Eidolon: its combat damage gains life, Lab Ox’s does not'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Martial Impetus: the enchanted creature attacks and pumps your other attacker'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Martial Impetus: P2’s goaded creature cannot attack you, their other creature can',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Killian, Decisive Mentor: an enchantment taps and goads, then the enchanted attacker draws',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Killian, Decisive Mentor: P2’s goaded creature cannot attack you, their other creature can',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Angelic Destiny: a 6/6 flying Angel, then it dies and the Aura returns to your hand',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Angelic Destiny: a 7/7 flying first-striking Angel attacks past Lab Ox and kills Lab Titan unharmed',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Sheltered by Ghosts: exile an opposing permanent, then attack with lifelink'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Sheltered by Ghosts: ward {2} counters an opponent’s Lab Shock aimed at the creature',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Eldrazi Conscription: a 12/12 trampler attacks and the defending player sacrifices two permanents',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Eldrazi Conscription: a blocked 12/12 trampler tramples over to the defending player',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Curse of Bounty: enchant a player, then attacking them untaps your nonland permanents',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Curse of Bounty: an opponent attacking the enchanted player untaps their nonland permanents',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Eidolon of Countless Battles: bestow onto a creature, then it becomes a creature again',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Eidolon of Countless Battles: the host grows by one per creature and one per Aura you control',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: [
      'Animate Dead: return an opponent’s creature, then it dies and the Aura goes with it',
    ],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Animate Dead: destroy the Aura and the returned creature is sacrificed'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Bess, Soul Nourisher: a 1/1 entering grows Bess, then her attack pumps the 1/1s'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Mikey & Leo, Chaos & Order: the first counter you put each turn draws a card'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Satoru, the Infiltrator: a free creature draws, a paid one does not'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Keeper of Secrets: flash back a spell to ping P2'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['River Kelpie: draw from a flashback and from persist'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Aurora Phoenix: cast a cascade spell to return it'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Aurora Phoenix: cast it, cascade into a cheaper spell, and see it fly'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Watcher for Tomorrow: hide a card, then get it back as it leaves'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Psychomancer: drain P2 when your artifact is destroyed'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Shard of the Void Dragon: attack, and grow from the sacrificed artifact'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Scavenging Ooze: exile a creature card to grow and gain life'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Imotekh the Stormlord: reanimate an artifact, then buff it at combat'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['The Ooze: Mutagens from a leaving creature and a graveyard exile'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['God-Eternal Rhonas: double your creatures, then go third from the top'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Candlekeep Sage: your commander draws as it enters and leaves'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Flickerwisp: exile P2's creature until the next end step"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Venser, the Sojourner: +2 blinks your Lab Ox at the end step'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Venser, the Sojourner: −1 makes creatures unblockable'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Venser, the Sojourner: −8 emblem exiles P2's Lab Ox"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ["Puppeteer Clique: steal P2's Lab Ox, attack, then exile it"],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Puppeteer Clique: destroy it and persist returns it'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Cryptek: your Lab Construct dies and returns tapped'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Living Death: swap the battlefield and graveyard creatures'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Technomancer: mill three, then return artifact creatures worth 6'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Victimize: sacrifice Lab Servo, return two creatures tapped'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Body Launderer: Lab Ox dies and it connives'],
  },
  {
    file: 'card-test-lab.spec.ts',
    titlePath: ['Body Launderer: it dies and returns Lab Servo, not Lab Ox'],
  },
  {
    file: 'combat-trigger-regressions.spec.ts',
    titlePath: ['Marchesa: keep dethrone after a life-total response'],
  },
  {
    file: 'combat-trigger-regressions.spec.ts',
    titlePath: ['Marchesa: ignore a non-leading defender'],
  },
  {
    file: 'combat-trigger-regressions.spec.ts',
    titlePath: ['Namor: boost allies attacking the defender'],
  },
  {
    file: 'combat-trigger-regressions.spec.ts',
    titlePath: ['Namor: keep the bonus after source removal'],
  },
  {
    file: 'combat-trigger-regressions.spec.ts',
    titlePath: ['Scriv: no life loss after the attacker dies'],
  },
  {
    file: 'combat-trigger-regressions.spec.ts',
    titlePath: ['Scriv: lose life when attacking the Contract controller'],
  },
];
for (const spec of VIEWER_CATALOG) {
  Object.freeze(spec.titlePath);
  Object.freeze(spec);
}
Object.freeze(VIEWER_CATALOG);
