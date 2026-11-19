import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { DecisionRequest, DecisionResponse, GameId } from '../packages/shared/src';
import { canonicalEngineStateHash } from '../packages/server/src/benchmark/replay';
import { sha256 } from '../packages/server/src/benchmark/hash';
import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
import { evaluateWarRoomGameplayAi } from '../packages/server/src/cards/gameplay-ai-evaluation';
import {
  loadGeneratorViewerEvidence,
  validateCurrentEvidenceSources,
  type ValidatedViewerEvidence,
} from './card-evidence-input';
import { SOURCE_FILES } from './card-evidence-sources';

const ORACLE_ID = '71c52bf5-2a5d-488e-8b15-7ef290e4b77d';
const ORACLE_SHA256 = '7014d3a7b8e20db7e2a12576165361775173e73cb28f1106afa40a659d6d0c74';
export const WAR_ROOM_TRACE_PATHS = {
  'war-room-viewer-dynamic-life-activation':
    'test-results/card-test-lab-War-Room-dyn-a9462-er-identity-life-activation/trace.zip',
  'war-room-viewer-colorless-mana': null,
} as const;
type ScenarioId = keyof typeof WAR_ROOM_TRACE_PATHS;
const fileSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function requireEvidence(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`War Room evidence failed: ${message}`);
}

export function chooseWarRoomEvidence(
  id: ScenarioId,
  request: DecisionRequest,
  performed: boolean,
): DecisionResponse {
  const expected = (action: DecisionRequest['legalActions'][number]) =>
    id === 'war-room-viewer-dynamic-life-activation'
      ? action.type === 'activateAbility' &&
        action.description ===
          "War Room: Pay life equal to your commanders' color identity colors: draw a card"
      : action.type === 'castSpell' && action.description === 'Cast War Room Mana Sink ({1})';
  requireEvidence(
    request.legalActions.every(
      (action) =>
        action.type === 'pass' ||
        action.type === 'passAndYieldTurn' ||
        (!performed && expected(action)) ||
        (id === 'war-room-viewer-dynamic-life-activation' &&
          action.type === 'castSpell' &&
          [
            'Cast War Room Mana Sink ({1})',
            'Cast War Room Action Witness ({0})',
            'Cast Three Color Commander ({0}) from the command zone',
            'Cast Three Color Commander ({0})',
          ].includes(action.description)),
    ),
    `unexpected action menu: ${JSON.stringify(request.legalActions)}`,
  );
  const actions = request.legalActions.filter(expected);
  const passes = request.legalActions.filter((action) => action.type === 'pass');
  requireEvidence(
    performed
      ? actions.length === 0 && passes.length === 1
      : actions.length === 1 && passes.length <= 1,
    'missing or ambiguous expected action',
  );
  const choice = performed ? passes[0]! : actions[0]!;
  return { requestId: request.requestId, actionId: choice.id };
}

export function driveWarRoomEvidence(id: ScenarioId) {
  const scenario = createCardTestScenario(id, `evidence-${id}` as GameId);
  requireEvidence(scenario !== null, `missing scenario ${id}`);
  let initial: ReturnType<typeof scenario.engine.getState> | null = null;
  let settled: {
    state: ReturnType<typeof scenario.engine.getState>;
    request: DecisionRequest;
  } | null = null;
  let decisions = 0;
  let performed = false;
  let paymentAction: DecisionRequest['legalActions'][number] | null = null;
  for (;;) {
    const step = scenario.engine.advance();
    if (initial === null) initial = structuredClone(scenario.engine.getState());
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (performed && settled === null && id === 'war-room-viewer-dynamic-life-activation') {
      settled = {
        state: structuredClone(scenario.engine.getState()),
        request: structuredClone(step.request),
      };
    }
    const response = chooseWarRoomEvidence(id, step.request, performed);
    if (!performed)
      paymentAction = structuredClone(
        step.request.legalActions.find((action) => action.id === response.actionId)!,
      );
    scenario.engine.submit(response);
    performed = true;
    requireEvidence(++decisions <= 40, `${id} exceeded its decision budget`);
  }
  requireEvidence(initial !== null && paymentAction !== null, 'missing normal-path payment action');
  const scenarioSha256 = sha256({
    metadata: scenario.metadata,
    seed: scenario.seed,
    initialState: initial,
  });
  const final = structuredClone(scenario.engine.getState());
  return {
    id,
    seed: scenario.seed,
    metadata: scenario.metadata,
    initial,
    paymentAction,
    settled,
    final,
    scenarioSha256,
    decisions,
    finalStateSha256: canonicalEngineStateHash(scenario.engine),
    eventLogSha256: sha256(final.eventLog),
  };
}

export function verifyWarRoomRun(run: ReturnType<typeof driveWarRoomEvidence>) {
  const draw = run.id === 'war-room-viewer-dynamic-life-activation';
  const player = (state: typeof run.initial) => state.players.find((seat) => seat.id === 'P1')!;
  const initial = player(run.initial),
    final = player(run.final);
  const names = (cards: { name: string }[]) => cards.map((card) => card.name).sort();
  const equal = (actual: unknown, expected: unknown, label: string) =>
    requireEvidence(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label}: ${JSON.stringify(actual)}`,
    );
  requireEvidence(run.metadata.oracleSha256 === ORACLE_SHA256, 'Oracle hash drifted');
  equal(initial.life, 40, 'initial life');
  equal(
    names(initial.hand),
    draw ? ['War Room Action Witness', 'War Room Mana Sink'] : ['War Room Mana Sink'],
    'initial hand',
  );
  equal(initial.library.length, draw ? 1 : 0, 'initial library');
  equal(
    names(run.initial.battlefield),
    draw ? ['Forest', 'Forest', 'Forest', 'War Room'] : ['War Room'],
    'initial sources',
  );
  requireEvidence(
    run.initial.battlefield.every((card) => !card.tapped),
    'initial untapped sources',
  );
  requireEvidence(
    Object.values(initial.manaPool).every((amount) => amount === 0),
    'initial empty pool',
  );
  equal(run.paymentAction.data?.['manaCost'], draw ? '{3}' : '{1}', 'normal-path mana cost');
  equal(
    run.paymentAction.data?.['paymentSourceNames'],
    draw ? ['Forest', 'Forest', 'Forest'] : ['War Room'],
    'normal-path payment sources',
  );
  equal(
    run.paymentAction.data?.['sourceName'],
    draw ? 'War Room' : 'War Room Mana Sink',
    'normal-path source',
  );
  if (draw) {
    equal(
      run.paymentAction.data?.['abilityCosts'],
      [
        {
          kind: 'mana',
          cost: { generic: 3, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
        },
        { kind: 'tap' },
        { kind: 'payLifeValue', amount: { kind: 'commanderIdentityColorCount' } },
      ],
      'exact activation costs',
    );
  }
  if (draw) {
    requireEvidence(run.settled !== null, 'missing settled P1 request');
    equal(run.settled.request.decidingPlayer, 'P1', 'settled deciding player');
    requireEvidence(
      run.settled.request.legalActions.some(
        (action) =>
          action.type === 'castSpell' &&
          action.description === 'Cast War Room Action Witness ({0})',
      ),
      'missing retained legal witness cast',
    );
    equal(run.settled.state.players[0]!.life, 37, 'settled life');
    equal(run.settled.state.players[0]!.hand.length, 3, 'settled hand');
    equal(run.settled.state.stack.length, 0, 'settled empty stack');
  }
  equal(final.life, draw ? 37 : 40, 'final life');
  equal(
    names(final.hand),
    draw ? ['Three Color Commander', 'War Room Action Witness', 'War Room Mana Sink'] : [],
    'final hand',
  );
  equal(final.library.length, 0, 'final library');
  equal(run.final.stack.length, 0, 'final empty stack');
  equal(
    names(run.final.battlefield),
    draw ? ['Forest', 'Forest', 'Forest', 'War Room'] : ['War Room', 'War Room Mana Sink'],
    'resolved battlefield',
  );
  requireEvidence(
    run.final.battlefield
      .filter((card) => card.typeLine.includes('Land'))
      .every((card) => card.tapped),
    'final tapped sources',
  );
  requireEvidence(
    Object.values(final.manaPool).every((amount) => amount === 0),
    'consumed mana',
  );
  const draws = run.final.eventLog.filter((event) => event.type === 'draw');
  equal(
    draws.map((event) => ({ actor: event.actorSeat, name: event.payload['name'] })),
    draw ? [{ actor: 'P1', name: 'Three Color Commander' }] : [],
    'exact draw events',
  );
  const activations = run.final.eventLog.filter((event) => event.type === 'activateAbility');
  const casts = run.final.eventLog.filter((event) => event.type === 'castSpell');
  equal(
    activations.map((event) => ({
      actor: event.actorSeat,
      source: event.payload['source'],
      description: event.payload['description'],
    })),
    draw
      ? [
          {
            actor: 'P1',
            source: 'War Room',
            description: "Pay life equal to your commanders' color identity colors: draw a card",
          },
        ]
      : [],
    'activation events',
  );
  equal(
    casts.map((event) => ({ actor: event.actorSeat, name: event.payload['name'] })),
    draw ? [] : [{ actor: 'P1', name: 'War Room Mana Sink' }],
    'cast events',
  );
  const resolutions = run.final.eventLog.filter((event) => event.type === 'resolved');
  equal(
    resolutions.map((event) => ({
      actor: event.actorSeat,
      description: event.payload['description'],
    })),
    [
      {
        actor: 'P1',
        description: draw
          ? "War Room \u2014 Pay life equal to your commanders' color identity colors: draw a card"
          : 'War Room Mana Sink',
      },
    ],
    'resolution events',
  );
  return {
    initialLife: initial.life,
    controllerLife: final.life,
    initialHand: names(initial.hand),
    finalHand: names(final.hand),
    initialLibrarySize: initial.library.length,
    finalLibrarySize: final.library.length,
    paymentAction: run.paymentAction,
    finalStackSize: run.final.stack.length,
    tappedSources: run.final.battlefield.filter((card) => card.tapped).map((card) => card.name),
    resolvedPermanents: names(run.final.battlefield),
    activationEvents: activations.length,
    castEvents: casts.length,
    drawEvents: draws.map((event) => ({ actor: event.actorSeat, name: event.payload['name'] })),
    resolutionEvents: resolutions.map((event) => event.payload['description']),
  };
}

export function verifyWarRoomReplay(
  first: ReturnType<typeof driveWarRoomEvidence>,
  replay: ReturnType<typeof driveWarRoomEvidence>,
) {
  requireEvidence(
    first.id === replay.id &&
      first.scenarioSha256 === replay.scenarioSha256 &&
      first.finalStateSha256 === replay.finalStateSha256 &&
      first.eventLogSha256 === replay.eventLogSha256,
    `${first.id} replay differed`,
  );
}

export function generateWarRoomVerificationEvidence(viewer?: ValidatedViewerEvidence) {
  requireEvidence(viewer !== undefined, 'actual browser trace is unresolved or missing');
  validateCurrentEvidenceSources(viewer, process.cwd());
  const files = Object.fromEntries(SOURCE_FILES.map((path) => [path, fileSha256(path)]));
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-war-room-evidence.ts',
    oracleId: ORACLE_ID,
    oracleSha256: ORACLE_SHA256,
    workspaceRevision: {
      gitHead: execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }).trim(),
      testedTree: viewer.testedTree,
      reportSha256: viewer.reportSha256,
      sourceSha256: sha256(files),
      files,
    },
    scenarios: (Object.keys(WAR_ROOM_TRACE_PATHS) as ScenarioId[]).map((id) => {
      const first = driveWarRoomEvidence(id),
        replay = driveWarRoomEvidence(id);
      const observations = verifyWarRoomRun(first);
      verifyWarRoomRun(replay);
      verifyWarRoomReplay(first, replay);
      return {
        id,
        seed: first.seed,
        oracleSha256: first.metadata.oracleSha256,
        clauseIds: first.metadata.clauseIds,
        scenarioSha256: first.scenarioSha256,
        finalStateSha256: first.finalStateSha256,
        replayFinalStateSha256: replay.finalStateSha256,
        eventLogSha256: first.eventLogSha256,
        replayEventLogSha256: replay.eventLogSha256,
        decisions: first.decisions,
        observations,
        viewerTrace: { path: viewer.traces[id]!.path, sha256: fileSha256(viewer.traces[id]!.path) },
      };
    }),
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
  const verification = generateWarRoomVerificationEvidence(viewer);
  const revision = verification.workspaceRevision;
  await writeReport('docs/reviews/war-room-verification.json', verification);
  await writeReport('docs/reviews/war-room-gameplay-ai.json', {
    ...evaluateWarRoomGameplayAi(),
    workspaceRevision: revision,
  });
  console.log('wrote War Room verification and gameplay-AI evidence');
}
