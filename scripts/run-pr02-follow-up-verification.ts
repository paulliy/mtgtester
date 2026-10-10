import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { getViewerEvidenceSourceFiles } from './card-evidence-input';

// Mechanic regressions and real viewer assertions, not a reviewed-card promotion receipt.
const tests = [
  'packages/engine/tests/pr02-card-coverage.test.ts',
  'packages/engine/tests/pr02-convoke-follow-ups.test.ts',
  'packages/engine/tests/pr02-life-casting-follow-ups.test.ts',
  'packages/engine/tests/pr02-replicate-follow-ups.test.ts',
  'packages/engine/tests/pr02-target-cost-follow-ups.test.ts',
  'packages/server/src/cards/pr02-follow-up-scenarios.test.ts',
  'packages/server/src/cards/card-test-scenarios-pr02.test.ts',
  'packages/server/src/cards/card-test-scenarios.test.ts',
  'apps/web/src/lib/actionLabels.test.ts',
] as const;
const root = process.cwd();
const output = resolve(process.argv[2] ?? 'test-results/pr02-follow-ups');
mkdirSync(output, { recursive: true });
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const files = [
  ...new Set([
    ...getViewerEvidenceSourceFiles(root),
    ...tests,
    'scripts/run-pr02-follow-up-verification.ts',
  ]),
].sort();
const capture = () =>
  Object.fromEntries(files.map((path) => [path, sha256(readFileSync(resolve(root, path)))]));
const before = capture();
const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(
  resolve(output, 'source-capture.json'),
  JSON.stringify({ gitHead, files: before }, null, 2),
);
const run = (args: string[], log: string) => {
  const result = spawnSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(resolve(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  return result.status;
};
const engineReport = resolve(output, 'engine.json');
const engineExitCode = run(
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    ...tests,
    '--maxWorkers=2',
    '--reporter=json',
    `--outputFile=${engineReport}`,
  ],
  'engine.log',
);
const viewer = spawnSync(
  'node',
  [
    'node_modules/@playwright/test/cli.js',
    'test',
    'apps/web/e2e/pr02-limited-mechanics.spec.ts',
    '--workers=1',
    '--reporter=json',
    `--output=${resolve(output, 'viewer-traces')}`,
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);
if (viewer.error) throw viewer.error;
writeFileSync(resolve(output, 'viewer.json'), viewer.stdout);
writeFileSync(resolve(output, 'viewer.log'), viewer.stderr);
const traces: Record<string, string> = {};
const collect = (directory: string) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name === 'trace.zip')
      traces[relative(root, path).replaceAll('\\', '/')] = sha256(readFileSync(path));
  }
};
collect(resolve(output, 'viewer-traces'));
const after = capture();
const sourcesUnchanged = JSON.stringify(before) === JSON.stringify(after);
writeFileSync(
  resolve(output, 'receipt.json'),
  JSON.stringify(
    {
      scope:
        'PR02 mechanic follow-ups; scripted human viewer actions; live gameplay AI not evaluated; no card review promotion',
      generatedAt: new Date().toISOString(),
      gitHead,
      sourceSha256: sha256(JSON.stringify(before)),
      sourcesUnchanged,
      engine: {
        exitCode: engineExitCode,
        report: relative(root, engineReport),
        sha256: sha256(readFileSync(engineReport)),
      },
      viewer: {
        exitCode: viewer.status,
        report: relative(root, resolve(output, 'viewer.json')),
        sha256: sha256(viewer.stdout),
        traces,
      },
    },
    null,
    2,
  ),
);
console.log(`PR02 reports and source-bound traces: ${output}`);
process.exitCode = engineExitCode === 0 && viewer.status === 0 && sourcesUnchanged ? 0 : 1;
