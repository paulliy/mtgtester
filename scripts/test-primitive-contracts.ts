import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { PRIMITIVE_CONTRACTS } from './contracts/primitive-contracts';
import { capturePrimitiveSources, loadPrimitiveEvidence } from './contracts/primitive-evidence';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output'))
  throw new Error('Use test:primitive-contracts [--output directory]');
const output = args.length
  ? resolve(args[1]!)
  : mkdtempSync(resolve(tmpdir(), 'mtgtester-primitive-contracts-'));
mkdirSync(output, { recursive: true });
const root = process.cwd();
const capture = capturePrimitiveSources(root);
// Reserved before execution; an existing run directory cannot be overwritten or reused.
writeFileSync(resolve(output, 'source-capture.json'), JSON.stringify(capture) + '\n', {
  flag: 'wx',
});
const files = [
  ...new Set(PRIMITIVE_CONTRACTS.flatMap((contract) => contract.cases.map((test) => test.file))),
].sort();
const vitest = createRequire(resolve(root, 'package.json')).resolve('vitest/vitest.mjs');
const run = spawnSync(
  'node',
  [
    vitest,
    'run',
    ...files,
    '--retry=0',
    '--reporter=default',
    '--reporter=./scripts/contracts/primitive-reporter.ts',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PRIMITIVE_CONTRACT_REPORT: resolve(output, 'report.json') },
  },
);
if (run.error || run.status !== 0)
  throw new Error(
    `Primitive contract execution failed: ${run.error?.message ?? run.status}; artifacts: ${output}`,
  );
if (JSON.stringify(capture) !== JSON.stringify(capturePrimitiveSources(root)))
  throw new Error('Primitive sources changed during execution');
const report = readFileSync(resolve(output, 'report.json'));
writeFileSync(
  resolve(output, 'manifest.json'),
  JSON.stringify({
    schemaVersion: 1,
    capture,
    reportSha256: createHash('sha256').update(report).digest('hex'),
    exitCode: run.status,
  }) + '\n',
  { flag: 'wx' },
);
const evidence = loadPrimitiveEvidence(root, output);
console.log(
  JSON.stringify({
    artifactDirectory: output,
    engineProven: evidence.capabilities,
    scope: 'primitive contracts only; card, viewer, and gameplay-AI evidence remain separate',
  }),
);
