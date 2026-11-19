import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DecisionRequest, DecisionResponse, GameId } from '../packages/shared/src';
import { canonicalEngineStateHash } from '../packages/server/src/benchmark/replay';
import {
  createCardTestScenario,
  type CardTestScenario,
} from '../packages/server/src/cards/card-test-scenarios';
import { evaluateArcaneDenialGameplayAi } from '../packages/server/src/cards/gameplay-ai-evaluation';
import { sha256 } from '../packages/server/src/benchmark/hash';
import {
  loadGeneratorViewerEvidence,
  validateCurrentEvidenceSources,
  type ValidatedViewerEvidence,
} from './card-evidence-input';
import { SOURCE_FILES } from './card-evidence-sources';

const ORACLE_ID = 'ab1cc360-b9de-48d9-9983-4dfe4a7d2a37';
const ORACLE_SHA256 = '7d764e957064fa08627fd48a85e1ea9aa50de341ffa09a88c2d36d0598156746';

const TRACE_PATHS = {
  'arcane-denial-viewer-draw-zero':
    'test-results/card-test-lab-Arcane-Denial-next-upkeep-draw-0/trace.zip',
  'arcane-denial-viewer-draw-two':
    'test-results/card-test-lab-Arcane-Denial-next-upkeep-draw-2/trace.zip',
} as const;

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitHead(): string {
  return execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

function workspaceRevision(viewer?: ValidatedViewerEvidence) {
  const files = Object.fromEntries(SOURCE_FILES.map((path) => [path, fileSha256(path)]));
  return {
    gitHead: gitHead(),
    ...(viewer && { testedTree: viewer.testedTree, reportSha256: viewer.reportSha256 }),
    sourceSha256: sha256(files),
    files,
  };
}

function objectNameMap(scenario: CardTestScenario): Map<string, string> {
  const state = scenario.engine.getState();
  const names = new Map<string, string>();
  for (const entry of state.stack) names.set(entry.id, entry.description);
  for (const player of state.players) {
    for (const card of [...player.hand, ...player.graveyard]) names.set(card.id, card.name);
  }
  return names;
}

function choose(
  request: DecisionRequest,
  scenario: CardTestScenario,
  drawCount: 0 | 2,
): DecisionResponse {
  const cast = request.legalActions.find((action) =>
    action.description.includes('Cast Arcane Denial'),
  );
  if (cast !== undefined) {
    const slots =
      (cast.interaction as { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined)
        ?.targetSlots ?? [];
    const targetSlot = slots[0];
    const names = objectNameMap(scenario);
    const target = targetSlot?.options.find((id) => names.get(id) === 'Lab Pending Spell');
    if (targetSlot === undefined || target === undefined) {
      throw new Error('Arcane Denial evidence scenario did not offer Lab Pending Spell as target');
    }
    return {
      requestId: request.requestId,
      actionId: cast.id,
      targets: [{ slot: targetSlot.slot, choice: target }],
    };
  }
  const optionalFirst = request.legalActions.find((action) =>
    action.description.includes('targeted spell controller'),
  );
  if (optionalFirst !== undefined) {
    return { requestId: request.requestId, actionId: optionalFirst.id };
  }
  const draw = request.legalActions.find(
    (action) => action.description === `Draw ${drawCount} cards`,
  );
  if (draw !== undefined) return { requestId: request.requestId, actionId: draw.id };
  const pass = request.legalActions.find((action) => action.type === 'pass');
  const fallback = pass ?? request.legalActions[0];
  if (fallback === undefined) throw new Error('Arcane Denial evidence request had no legal action');
  return { requestId: request.requestId, actionId: fallback.id };
}

function driveScenario(id: keyof typeof TRACE_PATHS, drawCount: 0 | 2) {
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
    scenario.engine.submit(choose(step.request, scenario, drawCount));
    if (++decisions > 40) throw new Error(`${id} exceeded its decision budget`);
  }
  return { scenario, scenarioSha256, decisions };
}

function assertEvidence(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Arcane Denial evidence failed: ${message}`);
}

function runScenario(
  id: keyof typeof TRACE_PATHS,
  drawCount: 0 | 2,
  viewer?: ValidatedViewerEvidence,
) {
  const first = driveScenario(id, drawCount);
  const replay = driveScenario(id, drawCount);
  const { scenario, scenarioSha256, decisions } = first;
  const state = scenario.engine.getState();
  const p1 = state.players.find((player) => player.id === 'P1')!;
  const p4 = state.players.find((player) => player.id === 'P4')!;
  const p1View = JSON.stringify(scenario.engine.view('P1'));
  const p3View = JSON.stringify(scenario.engine.view('P3'));
  const finalStateSha256 = canonicalEngineStateHash(scenario.engine);
  const replayFinalStateSha256 = canonicalEngineStateHash(replay.scenario.engine);
  const eventLogSha256 = sha256(state.eventLog);
  const replayEventLogSha256 = sha256(replay.scenario.engine.getState().eventLog);
  const tracePath = viewer === undefined ? TRACE_PATHS[id] : viewer.traces[id]!.path;
  assertEvidence(scenario.metadata.oracleSha256 === ORACLE_SHA256, `${id} Oracle hash drifted`);
  assertEvidence(state.turnNumber === 2, `${id} did not reach turn 2`);
  assertEvidence(
    scenario.engine.spectatorState().activePlayer === 'P2',
    `${id} did not fire during P2's immediately next upkeep`,
  );
  assertEvidence(
    p1.hand.map((card) => card.name).join('|') === 'Caster Secret Draw',
    `${id} did not give P1 exactly the mandatory card`,
  );
  assertEvidence(p4.hand.length === drawCount, `${id} gave P4 the wrong card count`);
  assertEvidence(
    p4.graveyard.some((card) => card.name === 'Lab Pending Spell'),
    `${id} did not counter the target spell`,
  );
  assertEvidence(
    state.eventLog.filter((event) => event.type === 'draw').length === drawCount + 1,
    `${id} emitted the wrong draw-event count`,
  );
  assertEvidence(
    !p4.hand.some((card) => p1View.includes(card.name) || p3View.includes(card.name)),
    `${id} leaked a P4 drawn card name to an opponent view`,
  );
  assertEvidence(
    finalStateSha256 === replayFinalStateSha256 && eventLogSha256 === replayEventLogSha256,
    `${id} was not deterministic under identical replayed decisions`,
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
      turnNumber: state.turnNumber,
      activePlayer: scenario.engine.spectatorState().activePlayer,
      p1Hand: p1.hand.map((card) => card.name),
      p4HandCount: p4.hand.length,
      pendingSpellInP4Graveyard: p4.graveyard.some((card) => card.name === 'Lab Pending Spell'),
      drawEvents: state.eventLog.filter((event) => event.type === 'draw').length,
      p1ViewLeaksP4DrawnNames: p4.hand.some((card) => p1View.includes(card.name)),
      p3ViewLeaksP4DrawnNames: p4.hand.some((card) => p3View.includes(card.name)),
    },
    viewerTrace: { path: tracePath, sha256: fileSha256(tracePath) },
  };
}

export function generateArcaneDenialVerificationEvidence(viewer?: ValidatedViewerEvidence) {
  if (viewer !== undefined) validateCurrentEvidenceSources(viewer, process.cwd());
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-arcane-denial-evidence.ts',
    oracleId: ORACLE_ID,
    oracleSha256: ORACLE_SHA256,
    workspaceRevision: workspaceRevision(viewer),
    scenarios: [
      runScenario('arcane-denial-viewer-draw-zero', 0, viewer),
      runScenario('arcane-denial-viewer-draw-two', 2, viewer),
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
    'docs/reviews/arcane-denial-verification.json',
    generateArcaneDenialVerificationEvidence(viewer),
  );
  await writeReport('docs/reviews/arcane-denial-gameplay-ai.json', {
    ...evaluateArcaneDenialGameplayAi(),
    workspaceRevision: revision,
  });
  console.log('wrote Arcane Denial verification and gameplay-AI evidence');
}
