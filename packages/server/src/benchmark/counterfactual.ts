import type { Engine } from '@mtg/engine';
import type { DecisionResponse, GameEvent, GameResult, PlayerId } from '@mtg/shared';
import type { ObservationPolicy, ReplayTranscript } from './replay';
import { canonicalEngineStateHash, reconstructAtDecision, replayHash } from './replay';

export type CounterfactualVerdict =
  'candidate_better' | 'indistinguishable' | 'baseline_better' | 'inconclusive';

export type CounterfactualHorizon =
  { kind: 'end_of_active_turn' } | { kind: 'stack_resolved' } | { kind: 'end_of_combat' };

export interface SeatResources {
  seat: PlayerId;
  alive: boolean;
  life: number;
  hand: number;
  library: number;
  graveyard: number;
  battlefield: number;
  lands: number;
  creatures: number;
  creaturePower: number;
  poison: number;
}

export interface CounterfactualEvaluator {
  version: string;
  limitations: string[];
  evaluate(engine: Engine, actor: PlayerId, result?: GameResult): number;
}

export interface CounterfactualPolicyFactory {
  policyFor(branch: 'candidate' | 'baseline'): (seat: PlayerId) => ObservationPolicy;
  policyId: string;
  rngPolicyId: string;
}

export interface CounterfactualBranchResult {
  branch: 'candidate' | 'baseline';
  termination:
    | 'horizon'
    | 'horizon_unreachable'
    | 'game_over'
    | 'actor_eliminated'
    | 'transition_limit'
    | 'illegal_initial_response'
    | 'policy_error';
  transitions: number;
  decisions: number;
  truncated: boolean;
  value: number | null;
  finalStateHash: string;
  resources: SeatResources[];
  result?: GameResult;
  error?: string;
  randomEventFingerprint: string;
}

export interface CounterfactualResult {
  schemaVersion: 1;
  evaluatorVersion: string;
  evaluatorLimitations: string[];
  rolloutPolicyId: string;
  rngPolicyId: string;
  horizon: CounterfactualHorizon;
  actor: PlayerId;
  forkDecisionIndex: number;
  sourceStateHash: string;
  sourceParity: boolean;
  candidate: CounterfactualBranchResult;
  baseline: CounterfactualBranchResult;
  /** V(S_baseline) - V(S_candidate). Positive means the baseline scored better. */
  baselineDisadvantage: number | null;
  verdict: CounterfactualVerdict;
  epsilon: number;
  uncertainty: 'low' | 'high';
  randomness: {
    identicalInitialSeedAndState: boolean;
    futureEventsForcedToAlign: false;
    divergenceDetected: boolean;
  };
  resourceDeltas: Array<{
    seat: PlayerId;
    candidateMinusBaseline: Omit<SeatResources, 'seat' | 'alive'>;
  }>;
}

export interface CounterfactualOptions {
  transcript: ReplayTranscript;
  forkDecisionIndex: number;
  actor: PlayerId;
  candidateResponse: DecisionResponse;
  baselineResponse: DecisionResponse;
  policies: CounterfactualPolicyFactory;
  horizon: CounterfactualHorizon;
  maxTransitions?: number;
  evaluator?: CounterfactualEvaluator;
  epsilon?: number;
}

const RANDOM_EVENT_TYPES = new Set(['shuffle', 'draw', 'bottomedCards', 'searchFound']);
const COMBAT_PHASES = new Set([
  'beginningOfCombat',
  'declareAttackers',
  'declareBlockers',
  'combatDamage',
  'endOfCombat',
]);

function resources(engine: Engine): SeatResources[] {
  const state = engine.getState();
  return state.players.map((player) => {
    const permanents = state.battlefield.filter((item) => item.controllerId === player.id);
    const creatures = permanents.filter((item) => item.typeLine.includes('Creature'));
    return {
      seat: player.id,
      alive: !player.hasLost,
      life: player.life,
      hand: player.hand.length,
      library: player.library.length,
      graveyard: player.graveyard.length,
      battlefield: permanents.length,
      lands: permanents.filter((item) => item.typeLine.includes('Land')).length,
      creatures: creatures.length,
      creaturePower: creatures.reduce((sum, item) => sum + Math.max(0, item.power ?? 0), 0),
      poison: player.poisonCounters,
    };
  });
}

function seatValue(item: SeatResources): number {
  if (!item.alive) return -100_000;
  return (
    item.life * 2 +
    item.hand * 4 +
    item.battlefield * 2 +
    item.lands +
    item.creatures * 2 +
    item.creaturePower -
    item.poison * 8
  );
}

export const DEFAULT_COUNTERFACTUAL_EVALUATOR: CounterfactualEvaluator = {
  version: 'public-resource-evaluator-v1',
  limitations: [
    'heuristic resource weights are not optimal-play value or regret',
    'historical full-state rollout evaluates one realized hidden world',
    'terminal outcomes override nonterminal board value',
    'the evaluator is not independent of heuristic policies that use similar signals',
  ],
  evaluate(engine, actor, result) {
    if (result?.winnerSeat === actor) return 1_000_000;
    const all = resources(engine);
    const self = all.find((item) => item.seat === actor);
    if (self === undefined || !self.alive) return -1_000_000;
    const opponents = all.filter((item) => item.seat !== actor);
    const opponentAverage =
      opponents.length === 0
        ? 0
        : opponents.reduce((sum, item) => sum + seatValue(item), 0) / opponents.length;
    const eliminated = opponents.filter((item) => !item.alive).length;
    return seatValue(self) - opponentAverage * 0.35 + eliminated * 10_000;
  },
};

function randomFingerprint(events: readonly GameEvent[]): string {
  return replayHash(
    events
      .filter((event) => RANDOM_EVENT_TYPES.has(event.type))
      .map((event) => ({ type: event.type, actor: event.actorSeat, payload: event.payload })),
  );
}

function horizonReached(
  engine: Engine,
  horizon: CounterfactualHorizon,
  start: { turn: number; active: PlayerId; sawCombat: boolean; sawStack: boolean },
): boolean {
  const state = engine.getState();
  const active = state.turnOrder[state.activePlayerIndex];
  if (horizon.kind === 'end_of_active_turn') {
    return state.turnNumber !== start.turn || active !== start.active;
  }
  if (COMBAT_PHASES.has(state.phase)) start.sawCombat = true;
  if (state.stack.length > 0) start.sawStack = true;
  if (horizon.kind === 'end_of_combat') return start.sawCombat && !COMBAT_PHASES.has(state.phase);
  return start.sawStack && state.stack.length === 0;
}

async function runBranch(
  branch: 'candidate' | 'baseline',
  engine: Engine,
  actor: PlayerId,
  initialResponse: DecisionResponse,
  policies: CounterfactualPolicyFactory,
  horizon: CounterfactualHorizon,
  maxTransitions: number,
  evaluator: CounterfactualEvaluator,
): Promise<CounterfactualBranchResult> {
  const startState = engine.getState();
  const startSequence = engine.eventsSince(0).at(-1)?.sequence ?? 0;
  const start = {
    turn: startState.turnNumber,
    active: startState.turnOrder[startState.activePlayerIndex]!,
    sawCombat: COMBAT_PHASES.has(startState.phase),
    sawStack: startState.stack.length > 0,
  };
  let transitions = 0;
  let decisions = 0;
  let result: GameResult | undefined;
  let termination: CounterfactualBranchResult['termination'] = 'transition_limit';
  let error: string | undefined;

  try {
    engine.submit(structuredClone(initialResponse));
  } catch (cause) {
    termination = 'illegal_initial_response';
    error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  }

  const policyFor = policies.policyFor(branch);
  if (error === undefined) {
    try {
      while (transitions++ < maxTransitions) {
        if (horizonReached(engine, horizon, start)) {
          termination = 'horizon';
          break;
        }
        const currentState = engine.getState();
        const currentActive = currentState.turnOrder[currentState.activePlayerIndex];
        if (
          horizon.kind !== 'end_of_active_turn' &&
          (currentState.turnNumber !== start.turn || currentActive !== start.active)
        ) {
          termination = 'horizon_unreachable';
          break;
        }
        const actorState = currentState.players.find((player) => player.id === actor);
        if (actorState?.hasLost === true) {
          termination = 'actor_eliminated';
          break;
        }
        const step = engine.advance();
        if (step.kind === 'continue') continue;
        if (step.kind === 'gameOver') {
          result = step.result;
          termination = 'game_over';
          break;
        }
        decisions++;
        const view = engine.view(step.request.decidingPlayer);
        const response = await policyFor(step.request.decidingPlayer)(step.request, view);
        engine.submit(response);
      }
    } catch (cause) {
      termination = 'policy_error';
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    }
  }

  const terminal =
    termination === 'horizon' || termination === 'game_over' || termination === 'actor_eliminated';
  const events = engine.eventsSince(startSequence + 1);
  return {
    branch,
    termination,
    transitions: Math.min(transitions, maxTransitions),
    decisions,
    truncated: !terminal,
    value: error === undefined ? evaluator.evaluate(engine, actor, result) : null,
    finalStateHash: canonicalEngineStateHash(engine),
    resources: resources(engine),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
    randomEventFingerprint: randomFingerprint(events),
  };
}

function numericDelta(
  candidate: SeatResources,
  baseline: SeatResources,
): Omit<SeatResources, 'seat' | 'alive'> {
  return {
    life: candidate.life - baseline.life,
    hand: candidate.hand - baseline.hand,
    library: candidate.library - baseline.library,
    graveyard: candidate.graveyard - baseline.graveyard,
    battlefield: candidate.battlefield - baseline.battlefield,
    lands: candidate.lands - baseline.lands,
    creatures: candidate.creatures - baseline.creatures,
    creaturePower: candidate.creaturePower - baseline.creaturePower,
    poison: candidate.poison - baseline.poison,
  };
}

export async function evaluateCounterfactual(
  options: CounterfactualOptions,
): Promise<CounterfactualResult> {
  const candidateFork = reconstructAtDecision(options.transcript, options.forkDecisionIndex);
  const baselineFork = reconstructAtDecision(options.transcript, options.forkDecisionIndex);
  const candidateSource = canonicalEngineStateHash(candidateFork.engine);
  const baselineSource = canonicalEngineStateHash(baselineFork.engine);
  const sourceParity = candidateSource === baselineSource;
  if (!sourceParity)
    throw new Error('counterfactual branches did not reconstruct identical source state');
  const evaluator = options.evaluator ?? DEFAULT_COUNTERFACTUAL_EVALUATOR;
  const maxTransitions = options.maxTransitions ?? 20_000;
  const [candidate, baseline] = await Promise.all([
    runBranch(
      'candidate',
      candidateFork.engine,
      options.actor,
      options.candidateResponse,
      options.policies,
      options.horizon,
      maxTransitions,
      evaluator,
    ),
    runBranch(
      'baseline',
      baselineFork.engine,
      options.actor,
      options.baselineResponse,
      options.policies,
      options.horizon,
      maxTransitions,
      evaluator,
    ),
  ]);
  const epsilon = options.epsilon ?? 1;
  const baselineDisadvantage =
    candidate.value === null || baseline.value === null ? null : baseline.value - candidate.value;
  const inconclusive = candidate.truncated || baseline.truncated || baselineDisadvantage === null;
  const verdict: CounterfactualVerdict = inconclusive
    ? 'inconclusive'
    : Math.abs(baselineDisadvantage) <= epsilon
      ? 'indistinguishable'
      : baselineDisadvantage > 0
        ? 'baseline_better'
        : 'candidate_better';
  const candidateBySeat = new Map(candidate.resources.map((item) => [item.seat, item]));
  const resourceDeltas = baseline.resources.flatMap((baselineSeat) => {
    const candidateSeat = candidateBySeat.get(baselineSeat.seat);
    return candidateSeat === undefined
      ? []
      : [
          {
            seat: baselineSeat.seat,
            candidateMinusBaseline: numericDelta(candidateSeat, baselineSeat),
          },
        ];
  });

  return {
    schemaVersion: 1,
    evaluatorVersion: evaluator.version,
    evaluatorLimitations: [...evaluator.limitations],
    rolloutPolicyId: options.policies.policyId,
    rngPolicyId: options.policies.rngPolicyId,
    horizon: options.horizon,
    actor: options.actor,
    forkDecisionIndex: options.forkDecisionIndex,
    sourceStateHash: candidateSource,
    sourceParity,
    candidate,
    baseline,
    baselineDisadvantage,
    verdict,
    epsilon,
    uncertainty: inconclusive || candidate.termination !== baseline.termination ? 'high' : 'low',
    randomness: {
      identicalInitialSeedAndState: sourceParity,
      futureEventsForcedToAlign: false,
      divergenceDetected: candidate.randomEventFingerprint !== baseline.randomEventFingerprint,
    },
    resourceDeltas,
  };
}
