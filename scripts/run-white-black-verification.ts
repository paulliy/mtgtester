import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { getViewerEvidenceSourceFiles } from './card-evidence-input';

// Generate development observations from real commands. This does not promote a card or
// replace clean-tree primitive receipts, clause review, or separate gameplay observations.
const root = process.cwd();
const output = resolve(process.argv[2] ?? '.tmp/white-black-verification');
mkdirSync(output, { recursive: true });
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const engineTests = readdirSync('packages/engine/tests')
  .filter((name) =>
    /^(white-black-control.*|discard-(event|player)-contract|spell-cast-limit-contract|planeswalker-combat-contract|phasing-elimination-contract)\.test\.ts$/.test(
      name,
    ),
  )
  .map((name) => `packages/engine/tests/${name}`);
const serverTests = readdirSync('packages/server/src/cards')
  .filter((name) => /^white-black-control.*\.test\.ts$/.test(name))
  .map((name) => `packages/server/src/cards/${name}`);
const viewerSpecs = readdirSync('apps/web/e2e')
  .filter((name) => /^white-black-control.*\.spec\.ts$/.test(name))
  .map((name) => `apps/web/e2e/${name}`);
const files = [
  ...new Set([
    ...getViewerEvidenceSourceFiles(root),
    ...engineTests,
    ...serverTests,
    ...viewerSpecs,
    'scripts/run-white-black-verification.ts',
    'docs/plans/white-black-control-verification-requirements.json',
  ]),
].sort();
const capture = () =>
  Object.fromEntries(files.map((path) => [path, sha(readFileSync(resolve(root, path)))]));
const before = capture();
const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty =
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
writeFileSync(
  resolve(output, 'sources.json'),
  JSON.stringify({ gitHead, dirty, files: before }, null, 2),
);
function run(command: string, args: string[], log: string) {
  process.stdout.write(`Running ${log}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(resolve(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  return result.status;
}
const engineExit = run(
  'bun',
  [
    'run',
    'test',
    '--',
    '--configLoader',
    'native',
    ...engineTests,
    ...serverTests,
    'packages/server/src/cards/card-test-scenarios.test.ts',
    '--reporter=json',
    `--outputFile=${resolve(output, 'engine.json')}`,
  ],
  'engine.log',
);
process.stdout.write('Running real viewer checks\n');
const viewer = spawnSync(
  'node',
  [
    'node_modules/@playwright/test/cli.js',
    'test',
    ...viewerSpecs,
    '--workers=1',
    '--reporter=json',
    `--output=${resolve(output, 'viewer-traces')}`,
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
if (viewer.error) throw viewer.error;
writeFileSync(resolve(output, 'viewer.json'), viewer.stdout ?? '');
writeFileSync(resolve(output, 'viewer.log'), viewer.stderr ?? '');
const traces: Record<string, string> = {};
function collect(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name === 'trace.zip')
      traces[relative(output, path).replaceAll('\\', '/')] = sha(readFileSync(path));
  }
}
collect(resolve(output, 'viewer-traces'));
const after = capture();
const changedSources = files.filter((path) => before[path] !== after[path]);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceKind: 'development-engine-and-real-viewer-observations',
  rulesCertification: false,
  gitHead,
  dirty,
  engineExit,
  viewerExit: viewer.status,
  sourceStable: changedSources.length === 0,
  changedSources,
  sourceSha256: sha(JSON.stringify(before)),
  engineReportSha256: sha(readFileSync(resolve(output, 'engine.json'))),
  viewerReportSha256: sha(readFileSync(resolve(output, 'viewer.json'))),
  traces,
};
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
process.stdout.write(`Reports: ${output}\n`);
if (engineExit !== 0 || viewer.status !== 0 || changedSources.length > 0) process.exitCode = 1;
