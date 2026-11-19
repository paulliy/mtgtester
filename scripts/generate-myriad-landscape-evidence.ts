import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DecisionRequest, DecisionResponse, GameId } from '../packages/shared/src';
import { canonicalEngineStateHash } from '../packages/server/src/benchmark/replay';
import { sha256 } from '../packages/server/src/benchmark/hash';
import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
import { evaluateMyriadLandscapeGameplayAi } from '../packages/server/src/cards/gameplay-ai-evaluation';
import {
  loadGeneratorViewerEvidence,
  validateCurrentEvidenceSources,
  type ValidatedViewerEvidence,
} from './card-evidence-input';
import { SOURCE_FILES } from './card-evidence-sources';

const ORACLE_ID = '2549bc57-9ffb-4053-9f10-f2a5f792b845';
const ORACLE_SHA256 = '696f038611a9d1540a151ab63ccc13e36fd4aa355a54806e741eb6a44f77442b';

const TRACE_PATHS = {
  'myriad-landscape-viewer-enters-tapped':
    'test-results/card-test-lab-Myriad-Lands-bbca7-mal-land-play-enters-tapped/trace.zip',
  'myriad-landscape-viewer-colorless-mana':
    'test-results/card-test-lab-Myriad-Lands-72cee-less-mana-pays-a-spell-cost/trace.zip',
  'myriad-landscape-viewer-shared-type-search':
    'test-results/card-test-lab-Myriad-Lands-c692e-enforces-a-shared-land-type/trace.zip',
} as const;

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function workspaceRevision(viewer?: ValidatedViewerEvidence) {
  const files = Object.fromEntries(SOURCE_FILES.map((path) => [path, fileSha256(path)]));
  return {
    gitHead: execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim(),
    ...(viewer && { testedTree: viewer.testedTree, reportSha256: viewer.reportSha256 }),
    sourceSha256: sha256(files),
    files,
  };
}

function choose(request: DecisionRequest): DecisionResponse {
  const action = request.legalActions.find(
    (candidate) =>
      candidate.description.includes('Play Myriad Landscape') ||
      candidate.description.includes('Cast Myriad Mana Sink') ||
      (candidate.description.includes('Island') &&
        candidate.description.includes('Myriad Shared Dual')),
  );
  if (action !== undefined) return { requestId: request.requestId, actionId: action.id };
  const activate = request.legalActions.find((candidate) =>
    candidate.description.includes('Search for up to two basic lands'),
  );
  if (activate !== undefined) return { requestId: request.requestId, actionId: activate.id };
  const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
  const fallback = pass ?? request.legalActions[0];
  if (fallback === undefined) throw new Error('Myriad Landscape evidence request had no action');
  return { requestId: request.requestId, actionId: fallback.id };
}

function driveScenario(id: keyof typeof TRACE_PATHS) {
  const scenario = createCardTestScenario(id, `evidence-${id}` as GameId);
  if (scenario === null) throw new Error(`missing Card Test Lab scenario ${id}`);
  const scenarioSha256 = sha256({
    metadata: scenario.metadata,
    seed: scenario.seed,
    initialState: scenario.engine.getState(),
  });
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    scenario.engine.submit(choose(step.request));
    if (++decisions > 40) throw new Error(`${id} exceeded its decision budget`);
  }
  return { scenario, scenarioSha256, decisions };
}

function assertEvidence(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Myriad Landscape evidence failed: ${message}`);
}

function runScenario(id: keyof typeof TRACE_PATHS, viewer?: ValidatedViewerEvidence) {
  const first = driveScenario(id);
  const replay = driveScenario(id);
  const { scenario, scenarioSha256, decisions } = first;
  const state = scenario.engine.getState();
  const p1 = state.players.find((player) => player.id === 'P1')!;
  const p2View = JSON.stringify(scenario.engine.view('P2'));
  const finalStateSha256 = canonicalEngineStateHash(scenario.engine);
  const replayFinalStateSha256 = canonicalEngineStateHash(replay.scenario.engine);
  const eventLogSha256 = sha256(state.eventLog);
  const replayEventLogSha256 = sha256(replay.scenario.engine.getState().eventLog);
  const tracePath = viewer === undefined ? TRACE_PATHS[id] : viewer.traces[id]!.path;
  const landscape = state.battlefield.find(
    (permanent) => permanent.controllerId === 'P1' && permanent.name === 'Myriad Landscape',
  );
  const found = state.battlefield.filter(
    (permanent) =>
      permanent.controllerId === 'P1' && ['Island', 'Myriad Shared Dual'].includes(permanent.name),
  );

  assertEvidence(scenario.metadata.oracleSha256 === ORACLE_SHA256, `${id} Oracle hash drifted`);
  if (id === 'myriad-landscape-viewer-enters-tapped') {
    assertEvidence(landscape?.tapped === true, 'normal land play did not enter tapped');
  } else if (id === 'myriad-landscape-viewer-colorless-mana') {
    assertEvidence(landscape?.tapped === true, 'colorless mana ability did not tap Landscape');
    assertEvidence(
      state.battlefield.some((permanent) => permanent.name === 'Myriad Mana Sink'),
      'sink did not resolve',
    );
  } else {
    assertEvidence(
      p1.graveyard.some((card) => card.name === 'Myriad Landscape'),
      'sacrifice cost was not paid',
    );
    assertEvidence(
      found.length === 2 && found.every((permanent) => permanent.tapped),
      'shared pair did not enter tapped',
    );
    assertEvidence(
      !p2View.includes('Myriad Private Library Secret'),
      'private library card leaked',
    );
  }
  assertEvidence(
    state.eventLog.some(
      (event) =>
        event.type === 'playLand' || event.type === 'castSpell' || event.type === 'activateAbility',
    ),
    `${id} did not use a normal engine path`,
  );
  assertEvidence(existsSync(tracePath), `${id} retained Playwright trace is missing`);
  assertEvidence(
    finalStateSha256 === replayFinalStateSha256 && eventLogSha256 === replayEventLogSha256,
    `${id} was not deterministic under replayed decisions`,
  );
  return {
    id,
    seed: scenario.seed,
    oracleSha256: scenario.metadata.oracleSha256,
    clauseIds: scenario.metadata.clauseIds,
    scenarioSha256,
    finalStateSha256,
    replayFinalStateSha256,
    eventLogSha256,
    replayEventLogSha256,
    decisions,
    observations: {
      landscapeTapped: landscape?.tapped ?? null,
      foundNames: found.map((permanent) => permanent.name),
      p1Graveyard: p1.graveyard.map((card) => card.name),
      p2ViewLeaksPrivateName: p2View.includes('Myriad Private Library Secret'),
    },
    viewerTrace: { path: tracePath, sha256: fileSha256(tracePath) },
  };
}

export function generateMyriadLandscapeVerificationEvidence(viewer?: ValidatedViewerEvidence) {
  if (viewer !== undefined) validateCurrentEvidenceSources(viewer, process.cwd());
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-myriad-landscape-evidence.ts',
    oracleId: ORACLE_ID,
    oracleSha256: ORACLE_SHA256,
    workspaceRevision: workspaceRevision(viewer),
    scenarios: (Object.keys(TRACE_PATHS) as (keyof typeof TRACE_PATHS)[]).map((id) =>
      runScenario(id, viewer),
    ),
  };
}

async function writeReport(outputPath: string, report: unknown) {
  writeFileSync(
    outputPath,
    await format(JSON.stringify(report), {
      ...(await resolveConfig(outputPath)),
      filepath: outputPath,
    }),
  );
}

if (import.meta.main) {
  const viewer = await loadGeneratorViewerEvidence(process.argv.slice(2));
  const revision = workspaceRevision(viewer);
  await writeReport(
    'docs/reviews/myriad-landscape-verification.json',
    generateMyriadLandscapeVerificationEvidence(viewer),
  );
  await writeReport('docs/reviews/myriad-landscape-gameplay-ai.json', {
    ...evaluateMyriadLandscapeGameplayAi(),
    workspaceRevision: revision,
  });
  console.log('wrote Myriad Landscape verification and gameplay-AI evidence');
}
