import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { OracleCard } from '../packages/shared/src';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
import { sha256 } from '../packages/server/src/benchmark/hash';
import { getViewerEvidenceSourceFiles } from './card-evidence-input';
import {
  loadPrimitiveEvidence,
  requireReviewedPrimitiveEligibility,
  validateCurrentPrimitiveEvidence,
} from './contracts/primitive-evidence';
import {
  evidenceSha256,
  validatePr08EngineReport,
  validatePr08ViewerReport,
  type Pr08ScenarioRequirement,
} from './pr08-verification-report';

// Run from a clean committed tree. Outputs are observations of real processes, not declarations.
const root = process.cwd();
const [outputArgument, primitiveArgument] = process.argv.slice(2);
if (!outputArgument || !primitiveArgument || process.argv.length !== 4)
  throw new Error(
    'Use run-pr08-verification.ts <new ignored output directory> <current primitive evidence directory>',
  );
const output = resolve(outputArgument);
const git = (args: string[]) =>
  execFileSync('git', ['--no-optional-locks', ...args], { encoding: 'utf8' }).trim();
if (git(['status', '--porcelain']) !== '')
  throw new Error('PR08 verification requires a clean committed working tree');
const gitHead = git(['rev-parse', 'HEAD']),
  testedTree = git(['rev-parse', 'HEAD^{tree}']);
const primitive = loadPrimitiveEvidence(root, primitiveArgument);
const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards;
interface Declaration {
  name: string;
  oracleSha256: string;
  implementationStatus: string;
  clauses: {
    id: string;
    oracleText: string;
    engineTestIds: string[];
    viewerScenarioIds: string[];
  }[];
}
const manifest = JSON.parse(
  readFileSync('packages/server/fixtures/card-verification-manifest.json', 'utf8'),
) as { cards: Record<string, Declaration> };
if (pins.length !== 23 || new Set(pins.map((pin) => pin.card.oracleId)).size !== 23)
  throw new Error('PR08 requires exactly 23 distinct pins');
requireReviewedPrimitiveEligibility(
  pins.map((pin) => ({
    canonicalOracleId: pin.card.oracleId,
    definition: interpretCard(pin.card),
  })),
  pins.map((pin) => pin.card.oracleId),
  primitive,
);
const requirements = new Map<string, Pr08ScenarioRequirement>();
const engineIds: string[] = [];
for (const pin of pins) {
  const declaration = manifest.cards[pin.card.oracleId];
  if (
    sha256(pin.card) !== pin.sha256 ||
    declaration?.oracleSha256 !== pin.sha256 ||
    declaration.implementationStatus !== 'implemented-reviewed'
  )
    throw new Error(`Unreviewed or drifted PR08 declaration: ${pin.card.name}`);
  for (const clause of declaration.clauses) {
    if (
      !pin.card.oracleText.includes(clause.oracleText) ||
      clause.engineTestIds.length === 0 ||
      clause.viewerScenarioIds.length === 0
    )
      throw new Error(`Incomplete clause: ${clause.id}`);
    engineIds.push(...clause.engineTestIds);
    for (const id of clause.viewerScenarioIds) {
      const scenario = createCardTestScenario(id, `evidence-${id}`);
      if (
        !scenario ||
        scenario.metadata.oracleSha256 !== pin.sha256 ||
        !scenario.metadata.clauseIds.includes(clause.id)
      )
        throw new Error(`Scenario clause/Oracle mismatch: ${id} / ${clause.id}`);
      requirements.set(id, {
        id,
        title: scenario.metadata.title,
        oracleSha256: scenario.metadata.oracleSha256,
        clauseIds: scenario.metadata.clauseIds,
      });
    }
  }
}
const engineTests = readdirSync('packages/engine/tests')
  .filter((name) => /^pr08.*\.test\.ts$/.test(name))
  .map((name) => `packages/engine/tests/${name}`);
const serverTests = readdirSync('packages/server/src/cards')
  .filter((name) => /^(pr08.*|card-test-scenarios-pr08)\.test\.ts$/.test(name))
  .map((name) => `packages/server/src/cards/${name}`);
const viewerSpecs = readdirSync('apps/web/e2e')
  .filter((name) => /^pr08.*\.spec\.ts$/.test(name))
  .map((name) => `apps/web/e2e/${name}`);
const contractFiles = readdirSync('scripts/contracts')
  .filter((name) => name.endsWith('.ts'))
  .map((name) => `scripts/contracts/${name}`);
const files = [
  ...new Set([
    ...getViewerEvidenceSourceFiles(root),
    ...engineTests,
    ...serverTests,
    ...viewerSpecs,
    ...contractFiles,
    'scripts/run-pr08-verification.ts',
    'scripts/pr08-verification-report.ts',
    'packages/server/fixtures/card-verification-manifest.json',
    'packages/engine/tests/fixtures/coverage-pr08-oracle.json',
  ]),
].sort();
const capture = () =>
  Object.fromEntries(files.map((path) => [path, evidenceSha256(readFileSync(path))]));
const before = capture();
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, 'sources.json'),
  JSON.stringify({ schemaVersion: 1, gitHead, testedTree, files: before }, null, 2) + '\n',
  { flag: 'wx' },
);
function run(args: string[], log: string, env = process.env) {
  const result = spawnSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  writeFileSync(resolve(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${log} failed with ${result.status}; reports retained at ${output}`);
  return result;
}
console.log('Running pinned PR08 engine and server cases');
const enginePath = resolve(output, 'engine.json');
run(
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    ...engineTests,
    ...serverTests,
    '--maxWorkers=2',
    '--retry=0',
    '--reporter=json',
    `--outputFile=${enginePath}`,
  ],
  'engine.log',
);
const engineBytes = readFileSync(enginePath);
const engine = validatePr08EngineReport(JSON.parse(engineBytes.toString('utf8')), engineIds);
console.log('Running every PR08 real frontend/backend scenario');
const viewerPath = resolve(output, 'viewer.json'),
  traceRoot = resolve(output, 'viewer-traces');
const viewer = run(
  [
    'node_modules/@playwright/test/cli.js',
    'test',
    ...viewerSpecs,
    '--workers=1',
    '--retries=0',
    '--repeat-each=1',
    '--reporter=json',
    `--output=${traceRoot}`,
  ],
  'viewer.log',
  { ...process.env, CI: 'true' },
);
writeFileSync(viewerPath, viewer.stdout);
const traces = await validatePr08ViewerReport(
  JSON.parse(viewer.stdout),
  [...requirements.values()],
  viewerSpecs,
  viewerPath,
  traceRoot,
);
if (
  JSON.stringify(before) !== JSON.stringify(capture()) ||
  git(['status', '--porcelain']) !== '' ||
  git(['rev-parse', 'HEAD^{tree}']) !== testedTree
)
  throw new Error('PR08 verification sources changed during execution');
validateCurrentPrimitiveEvidence(primitive);
for (const trace of Object.values(traces))
  if (evidenceSha256(readFileSync(trace.path)) !== trace.sha256)
    throw new Error('Retained viewer trace drifted');
writeFileSync(
  resolve(output, 'receipt.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      gitHead,
      testedTree,
      sourceSha256: evidenceSha256(JSON.stringify(before)),
      primitive: {
        directory: relative(root, resolve(primitiveArgument)),
        reportSha256: primitive.reportSha256,
      },
      engine: {
        passed: engine.passed,
        report: 'engine.json',
        sha256: evidenceSha256(engineBytes),
        requiredCaseIds: engine.requiredIds,
      },
      viewer: {
        passed: Object.keys(traces).length,
        report: 'viewer.json',
        sha256: evidenceSha256(viewer.stdout),
        scenarios: [...requirements.values()].map((requirement) => ({
          ...requirement,
          trace: traces[requirement.id],
        })),
      },
      gameplayAi: {
        status: 'not-evaluated',
        scope:
          'scripted legal opponents and human browser actions; live provider strategy is separate from correctness',
      },
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  `Verified 23 reviewed PR08 cards; ${engine.passed} engine/server tests and ${Object.keys(traces).length} real browser traces. Receipt: ${output}/receipt.json`,
);
