import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DecisionRequest, DecisionResponse, GameId } from '../packages/shared/src';
import { canonicalEngineStateHash } from '../packages/server/src/benchmark/replay';
import { sha256 } from '../packages/server/src/benchmark/hash';
import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
import { evaluateSmotheringTitheGameplayAi } from '../packages/server/src/cards/gameplay-ai-evaluation';
import {
  loadGeneratorViewerEvidence,
  validateCurrentEvidenceSources,
  type ValidatedViewerEvidence,
} from './card-evidence-input';
import { SOURCE_FILES } from './card-evidence-sources';

const ORACLE_ID = '153376c9-dffd-458c-8ce3-a4c8269bc4e9';
const ORACLE_SHA256 = '38346bcc71227873ac4c358bd89d277f9d1f94a65e7778392c5e0aefeb7ab2c4';

const TRACE_PATHS = {
  'smothering-tithe-viewer-pay':
    'test-results/card-test-lab-Smothering-Tithe-opponent-draws-and-pays/trace.zip',
  'smothering-tithe-viewer-decline':
    'test-results/card-test-lab-Smothering-Tithe-opponent-draws-and-declines/trace.zip',
} as const;

type ScenarioId = keyof typeof TRACE_PATHS;
type Outcome = 'pay' | 'decline';

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

function choose(request: DecisionRequest, outcome: Outcome): DecisionResponse {
  const cast = request.legalActions.find((action) =>
    action.description.includes('Cast Lab Pending Spell'),
  );
  if (cast !== undefined) return { requestId: request.requestId, actionId: cast.id };
  const paymentDescription = outcome === 'pay' ? 'Pay {2}' : "Don't pay {2}";
  const payment = request.legalActions.find((action) => action.description === paymentDescription);
  if (payment !== undefined) return { requestId: request.requestId, actionId: payment.id };
  const pass = request.legalActions.find((action) => action.type === 'pass');
  const fallback = pass ?? request.legalActions[0];
  if (fallback === undefined) throw new Error('Smothering Tithe evidence request had no action');
  return { requestId: request.requestId, actionId: fallback.id };
}

function driveScenario(id: ScenarioId, outcome: Outcome) {
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
    scenario.engine.submit(choose(step.request, outcome));
    if (++decisions > 40) throw new Error(`${id} exceeded its decision budget`);
  }
  return { scenario, scenarioSha256, decisions };
}

function assertEvidence(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Smothering Tithe evidence failed: ${message}`);
}

function runScenario(id: ScenarioId, outcome: Outcome, viewer?: ValidatedViewerEvidence) {
  const first = driveScenario(id, outcome);
  const replay = driveScenario(id, outcome);
  const { scenario, scenarioSha256, decisions } = first;
  const state = scenario.engine.getState();
  const p1 = state.players.find((player) => player.id === 'P1')!;
  const secretName = `Tithe Secret ${outcome === 'pay' ? 'Pay' : 'Decline'}`;
  const treasureCount = state.battlefield.filter(
    (permanent) => permanent.controllerId === 'P2' && permanent.name === 'Treasure',
  ).length;
  const tappedP1Forests = state.battlefield.filter(
    (permanent) =>
      permanent.controllerId === 'P1' && permanent.name === 'Forest' && permanent.tapped,
  ).length;
  const finalStateSha256 = canonicalEngineStateHash(scenario.engine);
  const replayFinalStateSha256 = canonicalEngineStateHash(replay.scenario.engine);
  const eventLogSha256 = sha256(state.eventLog);
  const replayEventLogSha256 = sha256(replay.scenario.engine.getState().eventLog);
  const p2View = JSON.stringify(scenario.engine.view('P2'));
  const p3View = JSON.stringify(scenario.engine.view('P3'));
  const tracePath = viewer === undefined ? TRACE_PATHS[id] : viewer.traces[id]!.path;

  assertEvidence(scenario.metadata.oracleSha256 === ORACLE_SHA256, `${id} Oracle hash drifted`);
  assertEvidence(
    p1.hand.map((card) => card.name).join('|') === secretName,
    `${id} did not draw exactly the prepared private card`,
  );
  assertEvidence(treasureCount === (outcome === 'pay' ? 0 : 1), `${id} Treasure count drifted`);
  assertEvidence(
    tappedP1Forests === (outcome === 'pay' ? 3 : 1),
    `${id} did not consume the expected mana sources`,
  );
  assertEvidence(
    state.eventLog.some((event) => event.type === 'castSpell') &&
      state.eventLog.filter((event) => event.type === 'draw').length === 1,
    `${id} did not use the normal cast/draw path`,
  );
  assertEvidence(
    state.eventLog.some((event) =>
      outcome === 'pay'
        ? event.type === 'unlessPaid' && event.actorSeat === 'P1'
        : event.type === 'unlessNotPaid' &&
          event.actorSeat === 'P1' &&
          event.payload['reason'] === 'declined',
    ),
    `${id} did not emit the public payment result`,
  );
  assertEvidence(
    !p2View.includes(secretName) && !p3View.includes(secretName),
    `${id} leaked the draw`,
  );
  assertEvidence(
    finalStateSha256 === replayFinalStateSha256 && eventLogSha256 === replayEventLogSha256,
    `${id} was not deterministic under replayed decisions`,
  );
  assertEvidence(existsSync(tracePath), `${id} retained Playwright trace is missing`);

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
      p1Hand: p1.hand.map((card) => card.name),
      treasureCount,
      tappedP1Forests,
      drawEvents: state.eventLog.filter((event) => event.type === 'draw').length,
      paymentEvent: outcome === 'pay' ? 'unlessPaid' : 'unlessNotPaid:declined',
      p2ViewLeaksDrawnName: p2View.includes(secretName),
      p3ViewLeaksDrawnName: p3View.includes(secretName),
    },
    viewerTrace: { path: tracePath, sha256: fileSha256(tracePath) },
  };
}

export function generateSmotheringTitheVerificationEvidence(viewer?: ValidatedViewerEvidence) {
  if (viewer !== undefined) validateCurrentEvidenceSources(viewer, process.cwd());
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-smothering-tithe-evidence.ts',
    oracleId: ORACLE_ID,
    oracleSha256: ORACLE_SHA256,
    workspaceRevision: workspaceRevision(viewer),
    scenarios: [
      runScenario('smothering-tithe-viewer-pay', 'pay', viewer),
      runScenario('smothering-tithe-viewer-decline', 'decline', viewer),
    ],
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
    'docs/reviews/smothering-tithe-verification.json',
    generateSmotheringTitheVerificationEvidence(viewer),
  );
  writeFileSync(
    'docs/reviews/smothering-tithe-gameplay-ai.json',
    `${JSON.stringify(
      { ...evaluateSmotheringTitheGameplayAi(), workspaceRevision: revision },
      null,
      2,
    )}\n`,
  );
  console.log('wrote Smothering Tithe verification and gameplay-AI evidence');
}
