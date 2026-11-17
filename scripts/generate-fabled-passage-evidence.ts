import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DecisionRequest, DecisionResponse, GameId } from '../packages/shared/src';
import { canonicalEngineStateHash } from '../packages/server/src/benchmark/replay';
import { sha256 } from '../packages/server/src/benchmark/hash';
import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
import { evaluateFabledPassageGameplayAi } from '../packages/server/src/cards/gameplay-ai-evaluation';
import {
  loadGeneratorViewerEvidence,
  validateCurrentEvidenceSources,
  type ValidatedViewerEvidence,
} from './card-evidence-input';
import { SOURCE_FILES } from './card-evidence-sources';

const ORACLE_ID = '0c85b8f7-0bd0-4680-9ec5-d4b110460a54';
const ORACLE_SHA256 = 'fd064f3f1c8289f7cd3a05433a31b03a8676ba4ce9035cd6706bd37087c9a7ef';
const SCENARIO_ID = 'fabled-passage-viewer-search-entry-untap';

const TRACE_PATH =
  'test-results/card-test-lab-Fabled-Passa-20ce6-entry-and-fourth-land-untap/trace.zip';

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
  const activate = request.legalActions.find((action) =>
    action.description.includes('Fabled Passage: Search for a basic land'),
  );
  if (activate !== undefined) return { requestId: request.requestId, actionId: activate.id };
  const island = request.legalActions.find((action) =>
    action.description.includes('Put Island onto the battlefield tapped'),
  );
  if (island !== undefined) return { requestId: request.requestId, actionId: island.id };
  const pass = request.legalActions.find((action) => action.type === 'pass');
  const fallback = pass ?? request.legalActions[0];
  if (fallback === undefined) throw new Error('Fabled Passage evidence request had no action');
  return { requestId: request.requestId, actionId: fallback.id };
}

function driveScenario() {
  const scenario = createCardTestScenario(SCENARIO_ID, `evidence-${SCENARIO_ID}` as GameId);
  if (scenario === null) throw new Error(`missing Card Test Lab scenario ${SCENARIO_ID}`);
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
    if (++decisions > 40) throw new Error(`${SCENARIO_ID} exceeded its decision budget`);
  }
  return { scenario, scenarioSha256, decisions };
}

function assertEvidence(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Fabled Passage evidence failed: ${message}`);
}

function runScenario(viewer?: ValidatedViewerEvidence) {
  const first = driveScenario();
  const replay = driveScenario();
  const { scenario, scenarioSha256, decisions } = first;
  const state = scenario.engine.getState();
  const p1 = state.players.find((player) => player.id === 'P1')!;
  const island = state.battlefield.find(
    (permanent) => permanent.controllerId === 'P1' && permanent.name === 'Island',
  );
  const p1Lands = state.battlefield.filter(
    (permanent) => permanent.controllerId === 'P1' && permanent.typeLine.includes('Land'),
  );
  const finalStateSha256 = canonicalEngineStateHash(scenario.engine);
  const replayFinalStateSha256 = canonicalEngineStateHash(replay.scenario.engine);
  const eventLogSha256 = sha256(state.eventLog);
  const replayEventLogSha256 = sha256(replay.scenario.engine.getState().eventLog);
  const p2View = JSON.stringify(scenario.engine.view('P2'));
  const p3View = JSON.stringify(scenario.engine.view('P3'));

  assertEvidence(scenario.metadata.oracleSha256 === ORACLE_SHA256, 'Oracle hash drifted');
  assertEvidence(
    p1.graveyard.some((card) => card.name === 'Fabled Passage'),
    'cost was not paid',
  );
  assertEvidence(island?.tapped === false, 'the bound fourth land was not untapped');
  assertEvidence(p1Lands.length === 4, 'post-entry land count was not four');
  assertEvidence(
    state.eventLog.some((event) => event.type === 'activateAbility') &&
      state.eventLog.some(
        (event) => event.type === 'searchFound' && event.payload['name'] === 'Island',
      ) &&
      state.eventLog.some((event) => event.type === 'shuffle'),
    'normal activation, search, or shuffle event is missing',
  );
  assertEvidence(
    !p2View.includes('Fabled Private Library Secret') &&
      !p3View.includes('Fabled Private Library Secret'),
    'private library card leaked',
  );
  assertEvidence(
    finalStateSha256 === replayFinalStateSha256 && eventLogSha256 === replayEventLogSha256,
    'replayed decisions were not deterministic',
  );
  const tracePath = viewer === undefined ? TRACE_PATH : viewer.traces[SCENARIO_ID]!.path;
  assertEvidence(existsSync(tracePath), 'retained Playwright trace is missing');

  return {
    id: SCENARIO_ID,
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
      fabledPassageInGraveyard: p1.graveyard.some((card) => card.name === 'Fabled Passage'),
      p1LandCount: p1Lands.length,
      islandTapped: island?.tapped,
      activationEvents: state.eventLog.filter((event) => event.type === 'activateAbility').length,
      searchFoundEvents: state.eventLog.filter((event) => event.type === 'searchFound').length,
      shuffleEvents: state.eventLog.filter((event) => event.type === 'shuffle').length,
      p2ViewLeaksPrivateName: p2View.includes('Fabled Private Library Secret'),
      p3ViewLeaksPrivateName: p3View.includes('Fabled Private Library Secret'),
    },
    viewerTrace: { path: tracePath, sha256: fileSha256(tracePath) },
  };
}

export function generateFabledPassageVerificationEvidence(viewer?: ValidatedViewerEvidence) {
  if (viewer !== undefined) validateCurrentEvidenceSources(viewer, process.cwd());
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-fabled-passage-evidence.ts',
    oracleId: ORACLE_ID,
    oracleSha256: ORACLE_SHA256,
    workspaceRevision: workspaceRevision(viewer),
    scenarios: [runScenario(viewer)],
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
    'docs/reviews/fabled-passage-verification.json',
    generateFabledPassageVerificationEvidence(viewer),
  );
  writeFileSync(
    'docs/reviews/fabled-passage-gameplay-ai.json',
    `${JSON.stringify(
      { ...evaluateFabledPassageGameplayAi(), workspaceRevision: revision },
      null,
      2,
    )}\n`,
  );
  console.log('wrote Fabled Passage verification and gameplay-AI evidence');
}
