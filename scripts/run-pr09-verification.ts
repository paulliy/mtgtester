import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { OracleCard } from '../packages/shared/src';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
import { PR09_ALL_SCENARIOS as PR09_SCENARIOS } from '../packages/server/src/cards/pr09-scenario-catalog';
import { oraclePinMatches } from './contracts/primitive-promotions';
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

/**
 * Generate clause-bound PR09 engine and real-browser evidence from a clean committed tree.
 * Each report and retained trace is bound to the tested source tree and exact Oracle pins.
 */
const root = process.cwd();
const [outputArgument, primitiveArgument] = process.argv.slice(2);
if (!outputArgument || !primitiveArgument || process.argv.length !== 4)
  throw new Error(
    'Use run-pr09-verification.ts <new ignored output directory> <current primitive evidence directory>',
  );
const output = resolve(outputArgument);
const git = (args: string[]) =>
  execFileSync('git', ['--no-optional-locks', ...args], { encoding: 'utf8' }).trim();
if (git(['status', '--porcelain']) !== '')
  throw new Error('PR09 verification requires a clean committed working tree');
const gitHead = git(['rev-parse', 'HEAD']),
  testedTree = git(['rev-parse', 'HEAD^{tree}']);
const primitive = loadPrimitiveEvidence(root, primitiveArgument);
const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr09-oracle.json', 'utf8')) as {
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
if (pins.length !== 31 || new Set(pins.map((pin) => pin.card.oracleId)).size !== 31)
  throw new Error('PR09 requires exactly 31 distinct pins');
requireReviewedPrimitiveEligibility(
  pins.map((pin) => ({
    canonicalOracleId: pin.card.oracleId,
    definition: interpretCard(pin.card),
  })),
  pins.map((pin) => pin.card.oracleId),
  primitive,
);
const requirements = new Map<string, Pr08ScenarioRequirement>();
const scenarioCatalog = new Map(PR09_SCENARIOS.map((scenario) => [scenario.id, scenario]));
if (scenarioCatalog.size !== PR09_SCENARIOS.length || scenarioCatalog.size === 0)
  throw new Error('PR09 scenario catalog is empty or contains duplicate IDs');
const engineIds: string[] = [];
for (const pin of pins) {
  const declaration = manifest.cards[pin.card.oracleId];
  if (
    !oraclePinMatches(pin.card, pin.sha256) ||
    declaration?.oracleSha256 !== pin.sha256 ||
    declaration.implementationStatus !== 'implemented-reviewed'
  )
    throw new Error(`Unreviewed or drifted PR09 declaration: ${pin.card.name}`);
  for (const clause of declaration.clauses) {
    if (
      ![pin.card.oracleText, pin.card.backFace?.oracleText ?? ''].some((text) =>
        text.includes(clause.oracleText),
      ) ||
      clause.engineTestIds.length === 0 ||
      clause.viewerScenarioIds.length === 0
    )
      throw new Error(`Incomplete clause: ${clause.id}`);
    engineIds.push(...clause.engineTestIds);
    for (const id of clause.viewerScenarioIds) {
      const catalogEntry = scenarioCatalog.get(id);
      const scenario = createCardTestScenario(id, `evidence-${id}`);
      if (
        !catalogEntry ||
        catalogEntry.cardName !== pin.card.name ||
        !scenario ||
        scenario.metadata.title !== catalogEntry.title ||
        scenario.metadata.oracleSha256 !== pin.sha256 ||
        !scenario.metadata.clauseIds.includes(clause.id)
      )
        throw new Error(`Scenario clause/Oracle mismatch: ${id} / ${clause.id}`);
      const previous = requirements.get(id);
      if (
        previous &&
        (previous.oracleSha256 !== pin.sha256 || previous.title !== catalogEntry.title)
      )
        throw new Error(`Scenario maps to multiple cards or titles: ${id}`);
      requirements.set(id, {
        id,
        title: scenario.metadata.title,
        oracleSha256: scenario.metadata.oracleSha256,
        clauseIds: scenario.metadata.clauseIds,
      });
    }
  }
}
if (
  requirements.size !== scenarioCatalog.size ||
  [...scenarioCatalog.keys()].some((id) => !requirements.has(id))
)
  throw new Error('PR09 catalog and manifest viewer scenario requirements differ');
const engineTests = readdirSync('packages/engine/tests')
  .filter((name) => /^pr09.*\.test\.ts$/.test(name) || name === 'chaos-warp.test.ts')
  .map((name) => `packages/engine/tests/${name}`);
const serverTests = readdirSync('packages/server/src/cards')
  .filter((name) => /^pr09.*\.test\.ts$/.test(name))
  .map((name) => `packages/server/src/cards/${name}`);
const viewerSpecs = [
  'apps/web/e2e/pr09-card-test-lab.spec.ts',
  'apps/web/e2e/pr09-library-card-test-lab.spec.ts',
  'apps/web/e2e/pr09-permanent-card-test-lab.spec.ts',
  'apps/web/e2e/pr09-choice-card-test-lab.spec.ts',
];
if (
  !engineTests.includes('packages/engine/tests/chaos-warp.test.ts') ||
  engineTests.length === 1 ||
  serverTests.length === 0 ||
  !readdirSync('apps/web/e2e').includes('pr09-card-test-lab.spec.ts')
)
  throw new Error('PR09 verification is missing required engine, server, or browser specs');
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
    'scripts/run-pr09-verification.ts',
    'scripts/pr08-verification-report.ts',
    'packages/server/src/cards/pr09-scenario-catalog.ts',
    'packages/server/fixtures/card-verification-manifest.json',
    'packages/engine/tests/fixtures/coverage-pr09-oracle.json',
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
console.log('Running pinned PR09 engine and server cases');
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
console.log('Running every PR09 real frontend/backend scenario');
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
  throw new Error('PR09 verification sources changed during execution');
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
  `Verified 31 reviewed PR09 cards; ${engine.passed} engine/server tests and ${Object.keys(traces).length} real browser traces. Receipt: ${output}/receipt.json`,
);
