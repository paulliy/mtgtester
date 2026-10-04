import { createHash } from 'node:crypto';
import { ENGINE_VERSION, Engine, type GameConfig } from '@mtg/engine';
import type {
  DecisionRequest,
  DecisionResponse,
  GameResult,
  PlayerId,
  PlayerView,
  TurnStrategy,
} from '@mtg/shared';
import { TurnPlanManager } from '../ai/turn-plan';

export interface ReplayDecisionRecord {
  index: number;
  request: DecisionRequest;
  response: DecisionResponse;
  observerView: PlayerView;
  requestHash: string;
  viewHash: string;
  /** Hash of the engine-relevant response fields; debug notes are intentionally excluded. */
  responseHash: string;
  stateHashBefore: string;
  stateHashAfterSubmit: string;
  submittedEventSequence: number;
}

export interface ReplayTranscript {
  schemaVersion: 1;
  engineVersion: string;
  gameConfig: GameConfig;
  seed: string;
  decisions: ReplayDecisionRecord[];
  termination: 'game_over' | 'decision_limit' | 'transition_limit';
  result?: GameResult;
}

export type ObservationPolicy = (
  request: DecisionRequest,
  view: PlayerView,
) => DecisionResponse | Promise<DecisionResponse>;

export interface ReplayCaptureOptions {
  maxDecisions?: number;
  maxTransitions?: number;
}

export interface ReplayParityResult {
  matchedDecisions: number;
  termination: ReplayTranscript['termination'];
  result?: GameResult;
}

export class ReplayMismatchError extends Error {
  constructor(
    readonly decisionIndex: number,
    readonly surface:
      | 'request'
      | 'recorded_request'
      | 'view'
      | 'recorded_view'
      | 'response'
      | 'state_before'
      | 'state_after'
      | 'decision_count',
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`replay mismatch at decision ${decisionIndex} (${surface})`);
    this.name = 'ReplayMismatchError';
  }
}

function normalized(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [normalized(key), normalized(item)])
      .sort(([left], [right]) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value instanceof Set) {
    return [...value]
      .map(normalized)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (item === undefined) continue;
      result[key] = normalized(item);
    }
    return result;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export function replayHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function canonicalEngineStateHash(engine: Engine): string {
  const state = engine.getState();
  const semantic = Object.fromEntries(
    Object.entries(state).filter(
      ([key]) =>
        key !== 'eventLog' && key !== 'sequenceSnapshots' && key !== 'pendingSnapshotSequence',
    ),
  );
  return replayHash(semantic);
}

export function semanticDecisionResponseHash(response: DecisionResponse): string {
  const { note: _debugNote, ...semantic } = response;
  return replayHash(semantic);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function latestEventSequence(engine: Engine): number {
  return engine.eventsSince(0).at(-1)?.sequence ?? 0;
}

function assertHash(
  index: number,
  surface: ReplayMismatchError['surface'],
  expected: string,
  actual: string,
): void {
  if (expected !== actual) throw new ReplayMismatchError(index, surface, expected, actual);
}

/** Capture setup, mulligan, payment, targeting, combat and every other surfaced response. */
export async function captureReplayTranscript(
  config: GameConfig,
  policyFor: (seat: PlayerId) => ObservationPolicy,
  options: ReplayCaptureOptions = {},
): Promise<ReplayTranscript> {
  const engine = new Engine(config);
  const decisions: ReplayDecisionRecord[] = [];
  const maxDecisions = options.maxDecisions ?? 100_000;
  const maxTransitions = options.maxTransitions ?? 1_000_000;
  let transitions = 0;

  while (transitions++ < maxTransitions) {
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      return {
        schemaVersion: 1,
        engineVersion: ENGINE_VERSION,
        gameConfig: clone(config),
        seed: config.seed,
        decisions,
        termination: 'game_over',
        result: clone(step.result),
      };
    }
    if (decisions.length >= maxDecisions) {
      return {
        schemaVersion: 1,
        engineVersion: ENGINE_VERSION,
        gameConfig: clone(config),
        seed: config.seed,
        decisions,
        termination: 'decision_limit',
      };
    }
    const request = clone(step.request);
    const view = clone(engine.view(request.decidingPlayer));
    const before = canonicalEngineStateHash(engine);
    const response = clone(await policyFor(request.decidingPlayer)(request, view));
    engine.submit(response);
    decisions.push({
      index: decisions.length,
      request,
      response,
      observerView: view,
      requestHash: replayHash(request),
      viewHash: replayHash(view),
      responseHash: semanticDecisionResponseHash(response),
      stateHashBefore: before,
      stateHashAfterSubmit: canonicalEngineStateHash(engine),
      submittedEventSequence: latestEventSequence(engine),
    });
  }

  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    gameConfig: clone(config),
    seed: config.seed,
    decisions,
    termination: 'transition_limit',
  };
}

/** Rebuild from initial conditions. Spectator snapshots and JSON-cloned engine objects are unused. */
export function replayTranscript(transcript: ReplayTranscript): ReplayParityResult {
  if (transcript.engineVersion !== ENGINE_VERSION) {
    throw new Error(
      `replay engine version mismatch: ${transcript.engineVersion} != ${ENGINE_VERSION}`,
    );
  }
  const engine = new Engine(clone(transcript.gameConfig));
  let index = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      if (index !== transcript.decisions.length) {
        throw new ReplayMismatchError(
          index,
          'decision_count',
          String(transcript.decisions.length),
          String(index),
        );
      }
      return { matchedDecisions: index, termination: 'game_over', result: clone(step.result) };
    }
    const expected = transcript.decisions[index];
    if (expected === undefined) {
      if (
        transcript.termination === 'decision_limit' ||
        transcript.termination === 'transition_limit'
      ) {
        return { matchedDecisions: index, termination: transcript.termination };
      }
      throw new ReplayMismatchError(
        index,
        'decision_count',
        String(transcript.decisions.length),
        String(index + 1),
      );
    }
    const view = engine.view(step.request.decidingPlayer);
    assertHash(index, 'recorded_request', expected.requestHash, replayHash(expected.request));
    assertHash(index, 'recorded_view', expected.viewHash, replayHash(expected.observerView));
    assertHash(index, 'request', expected.requestHash, replayHash(step.request));
    assertHash(index, 'view', expected.viewHash, replayHash(view));
    assertHash(index, 'state_before', expected.stateHashBefore, canonicalEngineStateHash(engine));
    assertHash(
      index,
      'response',
      expected.responseHash,
      semanticDecisionResponseHash(expected.response),
    );
    engine.submit(clone(expected.response));
    assertHash(
      index,
      'state_after',
      expected.stateHashAfterSubmit,
      canonicalEngineStateHash(engine),
    );
    index++;
    if (index === transcript.decisions.length && transcript.termination !== 'game_over') {
      return { matchedDecisions: index, termination: transcript.termination };
    }
  }
}

export interface ReconstructedDecision {
  engine: Engine;
  request: DecisionRequest;
  view: PlayerView;
}

export function reconstructAtDecision(
  transcript: ReplayTranscript,
  forkDecisionIndex: number,
): ReconstructedDecision {
  if (forkDecisionIndex < 0 || forkDecisionIndex >= transcript.decisions.length) {
    throw new RangeError('forkDecisionIndex must identify a captured decision');
  }
  const engine = new Engine(clone(transcript.gameConfig));
  let index = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      throw new ReplayMismatchError(
        index,
        'decision_count',
        String(forkDecisionIndex + 1),
        String(index),
      );
    }
    const expected = transcript.decisions[index]!;
    const view = engine.view(step.request.decidingPlayer);
    assertHash(index, 'recorded_request', expected.requestHash, replayHash(expected.request));
    assertHash(index, 'recorded_view', expected.viewHash, replayHash(expected.observerView));
    assertHash(index, 'request', expected.requestHash, replayHash(step.request));
    assertHash(index, 'view', expected.viewHash, replayHash(view));
    assertHash(index, 'state_before', expected.stateHashBefore, canonicalEngineStateHash(engine));
    if (index === forkDecisionIndex) return { engine, request: step.request, view };
    assertHash(
      index,
      'response',
      expected.responseHash,
      semanticDecisionResponseHash(expected.response),
    );
    engine.submit(clone(expected.response));
    assertHash(
      index,
      'state_after',
      expected.stateHashAfterSubmit,
      canonicalEngineStateHash(engine),
    );
    index++;
  }
}

export type TurnHarnessMode = 'ready' | 'asynchronous';

export interface TurnHarnessOptions {
  transcript: ReplayTranscript;
  forkDecisionIndex: number;
  mode: TurnHarnessMode;
  actingSeat: PlayerId;
  policyFor: (seat: PlayerId) => ObservationPolicy;
  strategy?: TurnStrategy;
  strategyFactory?: (request: DecisionRequest, view: PlayerView) => Promise<TurnStrategy | null>;
  /** Defaults to the evidence-scoped executor. Set false only for a legacy-control arm. */
  scopedPlanInvalidation?: boolean;
  maxTransitions?: number;
}

export interface TurnHarnessMetrics {
  mode: TurnHarnessMode;
  termination: 'end_of_active_turn' | 'elimination' | 'transition_limit' | 'game_over';
  transitions: number;
  decisions: number;
  decisionsBeforePlanAvailable: number;
  planInstalled: boolean;
  planGenerationSettled: boolean;
  latePlanDiscarded: boolean;
  planActionsAccepted: number;
  sourceToInstallChanged: boolean | 'not_applicable';
  handDelta: number;
  battlefieldDelta: number;
  landDelta: number;
  damageToOpponents: number;
  eliminations: number;
  threatsAnswered: number;
  unusedMana: number;
  lifecycle: ReturnType<TurnPlanManager['getLifecycleEvents']>;
}

function boardMetrics(view: PlayerView, seat: PlayerId): { battlefield: number; lands: number } {
  const own = view.battlefield.filter((permanent) => permanent.controller === seat);
  return {
    battlefield: own.length,
    lands: own.filter((permanent) => permanent.typeLine?.includes('Land') === true).length,
  };
}

/**
 * Controlled active-turn runner. Policies receive only their PlayerView. Ready mode installs a
 * completed plan before the first decision; asynchronous mode starts generation at the identical
 * source and records how many decisions elapsed before installation.
 */
export async function runTurnHarness(options: TurnHarnessOptions): Promise<TurnHarnessMetrics> {
  const reconstructed = reconstructAtDecision(options.transcript, options.forkDecisionIndex);
  const { engine } = reconstructed;
  const sourceRequest = reconstructed.request;
  const sourceView = engine.view(options.actingSeat);
  const sourceHash = replayHash(sourceView);
  const startSequence = latestEventSequence(engine);
  const startBoard = boardMetrics(sourceView, options.actingSeat);
  const plan = new TurnPlanManager(options.scopedPlanInvalidation ?? true);
  let available: TurnStrategy | null = options.mode === 'ready' ? (options.strategy ?? null) : null;
  let settled = options.mode === 'ready';
  let installed = false;
  let decisions = 0;
  let decisionsBeforePlanAvailable = 0;
  let installViewHash: string | null = null;
  const asyncPlan =
    options.mode === 'asynchronous'
      ? (options.strategyFactory?.(sourceRequest, sourceView) ?? Promise.resolve(null)).then(
          (value) => {
            available = value;
            settled = true;
          },
          () => {
            available = null;
            settled = true;
          },
        )
      : Promise.resolve();
  void asyncPlan;

  const install = (request: DecisionRequest): void => {
    if (installed || available === null) return;
    const view = engine.view(options.actingSeat);
    plan.recordPlan(request, available.plannedActions, engine, { sourceView });
    installed = true;
    installViewHash = replayHash(view);
  };
  if (options.mode === 'ready') install(sourceRequest);

  const maxTransitions = options.maxTransitions ?? 20_000;
  let transitions = 0;
  let termination: TurnHarnessMetrics['termination'] = 'transition_limit';
  const startingTurn = sourceRequest.turn;
  const startingActive = sourceRequest.activePlayer;

  while (transitions++ < maxTransitions) {
    await Promise.resolve();
    if (!installed && settled && available !== null) install(sourceRequest);
    const state = engine.getState();
    if (state.players.find((player) => player.id === options.actingSeat)?.hasLost === true) {
      termination = 'elimination';
      break;
    }
    if (
      state.turnNumber !== startingTurn ||
      state.turnOrder[state.activePlayerIndex] !== startingActive
    ) {
      termination = 'end_of_active_turn';
      break;
    }
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      termination = 'game_over';
      break;
    }
    decisions++;
    if (!installed) decisionsBeforePlanAvailable++;
    const view = engine.view(step.request.decidingPlayer);
    let response: DecisionResponse | null = null;
    if (step.request.decidingPlayer === options.actingSeat && installed) {
      response = plan.tryExecutePlan(step.request, engine);
    }
    response ??= await options.policyFor(step.request.decidingPlayer)(step.request, view);
    plan.recordDecision(
      step.request,
      response,
      response.note?.startsWith('TurnPlan:') === true ? 'plan' : 'primary',
      engine,
    );
    engine.submit(response);
    plan.recordAccepted(step.request, response, engine);
  }
  const endView = engine.view(options.actingSeat);
  const endBoard = boardMetrics(endView, options.actingSeat);
  const events = engine.eventsSince(startSequence + 1);
  const accepted = plan.getLifecycleEvents().filter((event) => event.status === 'accepted').length;
  const damageToOpponents = events
    .filter(
      (event) =>
        event.type === 'damage' &&
        event.payload['controller'] === options.actingSeat &&
        typeof event.payload['target'] === 'string' &&
        event.payload['target'] !== options.actingSeat,
    )
    .reduce(
      (total, event) =>
        total + (typeof event.payload['amount'] === 'number' ? event.payload['amount'] : 0),
      0,
    );
  return {
    mode: options.mode,
    termination,
    transitions: Math.min(transitions, maxTransitions),
    decisions,
    decisionsBeforePlanAvailable,
    planInstalled: installed,
    planGenerationSettled: settled,
    latePlanDiscarded: options.mode === 'asynchronous' && settled && !installed,
    planActionsAccepted: accepted,
    sourceToInstallChanged:
      installViewHash === null ? 'not_applicable' : sourceHash !== installViewHash,
    handDelta: endView.hand.length - sourceView.hand.length,
    battlefieldDelta: endBoard.battlefield - startBoard.battlefield,
    landDelta: endBoard.lands - startBoard.lands,
    damageToOpponents,
    eliminations: events.filter((event) => event.type === 'playerEliminated').length,
    threatsAnswered: events.filter(
      (event) =>
        event.actorSeat === options.actingSeat &&
        ['destroy', 'exile', 'counterSpell', 'returnToHand'].includes(event.type),
    ).length,
    unusedMana: Object.values(endView.availableMana).reduce((sum, amount) => sum + amount, 0),
    lifecycle: plan.getLifecycleEvents(),
  };
}
