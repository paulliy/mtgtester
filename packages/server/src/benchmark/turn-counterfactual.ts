/**
 * The turn-level counterfactual for ADR 0045's strategist study. It forks a captured game at the
 * first decision of one seat's turn and plays the rest of the horizon once per arm:
 *
 * - a **bot arm** is the steered card-aware bot under one knob setting, kept until the horizon
 *   (hold, mana held up and avoiding overextension act across turns);
 * - a **turn arm** (the tactician, or a reviewer's scripted reference line) plays the forked turn
 *   only, then the seat plays the card-aware bot with its recorded knobs.
 *
 * The other seats play the card-aware bot with the knobs recorded for them, frozen; no strategist
 * runs inside a rollout. The horizon is the end of the seat's next turn. The engine cannot re-deal
 * hidden zones, so trials vary only the rollout policies' seeds: every trial of a turn plays the
 * same deal (ADR 0045 decision 1.3).
 *
 * Nothing here decides legality: every response comes from a policy choosing among the engine's
 * menu, and an answer the engine refuses ends the arm as `illegal_response`.
 */

import type { Engine } from '@mtg/engine';
import type {
  BotSteering,
  DecisionRequest,
  DecisionResponse,
  GameResult,
  PlayerId,
  PlayerView,
} from '@mtg/shared';
import { HeuristicDecisionProvider, type ActiveObligation } from '@mtg/bot';
import { knowledgeFor } from '../ai/bot-tactician';
import type { CounterfactualEvaluator } from './counterfactual';
import { canonicalEngineStateHash, reconstructAtDecision, type ReplayTranscript } from './replay';

/** A policy that plays the forked turn and returns null to hand a decision to the bot. */
export type TurnPolicy = ((
  request: DecisionRequest,
  view: PlayerView,
) => DecisionResponse | null | Promise<DecisionResponse | null>) & {
  /**
   * Asked once the forked turn is over: why the policy did not finish what it set out to play (a
   * reviewer's line with steps never reached), or null when it did.
   */
  unfinished?: () => string | null;
};

/** Builds an arm's turn policy on the forked engine (a provider needs the engine it plays). */
export type TurnPolicyFactory = (engine: Engine, seat: PlayerId) => TurnPolicy;

export type StudyArm =
  | { kind: 'bot'; id: string; steering: BotSteering | undefined; knob?: string }
  | { kind: 'tactician'; id: string; policyFor: TurnPolicyFactory; withContext: boolean }
  | { kind: 'reference'; id: string; policyFor: TurnPolicyFactory };

/** A marked turn: where to fork, whose turn it is, and the knobs every seat had in force. */
export interface TurnFork {
  transcript: ReplayTranscript;
  /** The first decision of the seat's turn, as an index into `transcript.decisions`. */
  forkDecisionIndex: number;
  seat: PlayerId;
  knobsBySeat: Partial<Record<PlayerId, BotSteering>>;
  /**
   * Deal obligations each seat's bot enforced at the fork, from a capture made with diplomacy.
   * Every rollout bot holds them to the horizon, as the captured game's bots did (a deal that
   * would have run out inside the horizon is held a little long; no new deals are made).
   */
  obligationsBySeat?: Partial<Record<PlayerId, readonly ActiveObligation[]>>;
}

export interface ArmRun {
  arm: string;
  rolloutSeed: string;
  termination:
    | 'horizon'
    | 'game_over'
    | 'seat_eliminated'
    | 'decision_limit'
    | 'illegal_response'
    /** The engine stopped the game (unsupported behaviour, a budget, an invariant), not a result. */
    | 'halted'
    /** A reference line could not be played as written. */
    | 'invalid_line';
  finalStateHash: string;
  /** Evaluator id → value at the horizon, from the seat's point of view. */
  values: Record<string, number>;
  /** The seat's decisions during the forked turn, as the menu worded them. */
  forkedTurnActions: string[];
  /** Turn-arm decisions the bot answered because the arm's policy returned null or failed. */
  handedToBot: number;
  result?: GameResult;
  error?: string;
}

export interface RunArmOptions {
  rolloutSeed: string;
  evaluators: readonly CounterfactualEvaluator[];
  maxDecisions?: number;
}

/** The seat whose turn a request is in, and that turn's number. */
function turnOf(request: DecisionRequest): { turn: number; active: PlayerId } {
  return { turn: request.turn, active: request.activePlayer };
}

/** Play one arm from the fork to the horizon. */
export async function runArm(
  fork: TurnFork,
  arm: StudyArm,
  options: RunArmOptions,
): Promise<ArmRun> {
  const { engine, request: first } = reconstructAtDecision(fork.transcript, fork.forkDecisionIndex);
  const forkTurn = turnOf(first);
  if (forkTurn.active !== fork.seat || first.decidingPlayer !== fork.seat)
    throw new Error(
      `fork ${fork.forkDecisionIndex} is not ${fork.seat}'s decision in ${fork.seat}'s turn`,
    );
  const knowledge = knowledgeFor(engine);
  const bots = new Map<string, HeuristicDecisionProvider>();
  const botFor = (seat: PlayerId, steering: BotSteering | undefined): HeuristicDecisionProvider => {
    const key = `${seat}`;
    let bot = bots.get(key);
    if (bot === undefined) {
      bot = new HeuristicDecisionProvider(
        `${options.rolloutSeed}-${seat}`,
        () => engine.view(seat),
        {
          knowledge,
          steering: () => steering,
          ...(fork.obligationsBySeat?.[seat] === undefined
            ? {}
            : {
                diplomacy: {
                  obligations: () => fork.obligationsBySeat![seat]!,
                  startingOpponents: Math.max(0, engine.getState().players.length - 1),
                },
              }),
        },
      );
      bots.set(key, bot);
    }
    return bot;
  };
  const seatKnobs = arm.kind === 'bot' ? arm.steering : fork.knobsBySeat[fork.seat];
  const turnPolicy = arm.kind === 'bot' ? null : arm.policyFor(engine, fork.seat);
  const forkedTurnActions: string[] = [];
  let handedToBot = 0;
  let horizonTurn: number | null = null;
  let request: DecisionRequest | null = first;
  let forkedTurnOver = false;
  let decisions = 0;
  const maxDecisions = options.maxDecisions ?? 5_000;
  let termination: ArmRun['termination'] = 'horizon';
  let error: string | undefined;
  let result: GameResult | undefined;

  outer: while (request !== null) {
    if (decisions++ >= maxDecisions) {
      termination = 'decision_limit';
      break;
    }
    // The horizon: the end of the seat's next turn after the forked one.
    if (request.activePlayer === fork.seat && request.turn > forkTurn.turn && horizonTurn === null)
      horizonTurn = request.turn;
    if (horizonTurn !== null && request.turn > horizonTurn) break;
    // The forked turn is over: a reference line must have played every step by now.
    if (!forkedTurnOver && request.turn !== forkTurn.turn) {
      forkedTurnOver = true;
      const unfinished = arm.kind === 'reference' ? (turnPolicy?.unfinished?.() ?? null) : null;
      if (unfinished !== null) {
        termination = 'invalid_line';
        error = unfinished;
        break;
      }
    }

    const seat = request.decidingPlayer;
    const view = engine.view(seat);
    const inForkedTurn = request.turn === forkTurn.turn;
    let response: DecisionResponse | null = null;
    if (seat === fork.seat && turnPolicy !== null && inForkedTurn) {
      try {
        response = await turnPolicy(request, view);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        // A reviewer's line that cannot be played is not a line at all: stop, and say why.
        if (arm.kind === 'reference') {
          termination = 'invalid_line';
          break;
        }
        response = null;
      }
      if (response === null) handedToBot++;
    }
    const steering = seat === fork.seat ? seatKnobs : fork.knobsBySeat[seat];
    const bot = botFor(seat, steering);
    if (response === null) response = bot.decide(request);
    else bot.record(request, response);
    if (seat === fork.seat && inForkedTurn) {
      const action = request.legalActions.find((candidate) => candidate.id === response!.actionId);
      forkedTurnActions.push(action?.description ?? `action ${response.actionId}`);
    }
    try {
      engine.submit(response);
    } catch (cause) {
      termination = 'illegal_response';
      error = cause instanceof Error ? cause.message : String(cause);
      break;
    }
    request = null;
    for (;;) {
      const step = engine.advance();
      if (step.kind === 'continue') continue;
      if (step.kind === 'gameOver') {
        result = step.result;
        if (step.result.halted) {
          termination = 'halted';
          error = step.result.haltReason ?? 'the engine halted';
        } else termination = 'game_over';
        break outer;
      }
      request = step.request;
      break;
    }
    const seatPlayer = engine.getState().players.find((player) => player.id === fork.seat);
    if (seatPlayer?.hasLost === true) {
      termination = 'seat_eliminated';
      break;
    }
  }

  const values: Record<string, number> = {};
  for (const evaluator of options.evaluators)
    values[evaluator.version] = evaluator.evaluate(engine, fork.seat, result);
  return {
    arm: arm.id,
    rolloutSeed: options.rolloutSeed,
    termination,
    finalStateHash: canonicalEngineStateHash(engine),
    values,
    forkedTurnActions,
    handedToBot,
    ...(result !== undefined && { result }),
    ...(error !== undefined && { error }),
  };
}

/** Play every arm over every rollout seed. */
export async function runTurnStudy(
  fork: TurnFork,
  arms: readonly StudyArm[],
  seeds: readonly string[],
  evaluators: readonly CounterfactualEvaluator[],
): Promise<ArmRun[]> {
  const runs: ArmRun[] = [];
  for (const arm of arms)
    for (const seed of seeds) runs.push(await runArm(fork, arm, { rolloutSeed: seed, evaluators }));
  return runs;
}

/**
 * Seed variation counts as too narrow when the bot arms reach the same final state on every seed
 * for most marked turns (ADR 0045 decision 1.3): then re-sampling hidden zones has to be built.
 */
export function seedVariationTooNarrow(
  runsByTurn: readonly (readonly ArmRun[])[],
  botArmIds: ReadonlySet<string>,
  share = 0.5,
): boolean {
  if (runsByTurn.length === 0) return false;
  const identical = runsByTurn.filter((runs) => {
    const byArm = new Map<string, Set<string>>();
    for (const run of runs)
      if (botArmIds.has(run.arm))
        byArm.set(run.arm, (byArm.get(run.arm) ?? new Set()).add(run.finalStateHash));
    return byArm.size > 0 && [...byArm.values()].every((hashes) => hashes.size === 1);
  }).length;
  return identical / runsByTurn.length > share;
}
