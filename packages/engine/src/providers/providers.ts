/**
 * Scripted and random decision providers (brief §14.1 Phase 2: the game is driven by
 * scripted decisions — no AI exists yet). The server's Gemini player replaces these in
 * Phase 3 behind the same request/response contract.
 */

import type { DecisionRequest, DecisionResponse, GameResult, TargetChoice } from '@mtg/shared';
import { Prng } from '../rng/prng';
import type { Engine } from '../engine';

export interface DecisionProvider {
  decide(request: DecisionRequest): DecisionResponse;
}

/** Fill required targets with the first legal choice for each slot. */
function firstTargets(request: DecisionRequest, actionId: number): TargetChoice[] {
  const action = request.legalActions.find((a) => a.id === actionId);
  return (action?.targets ?? []).map((slot) => ({
    slot: slot.slot,
    choice: slot.options[0] as string,
  }));
}

/**
 * Uniformly random choices from its own seeded PRNG (NOT the game's — providers are
 * players, not the engine). Deterministic given the seed, so full-game tests replay.
 */
export class RandomDecisionProvider implements DecisionProvider {
  private readonly rng: Prng;

  constructor(seed: string) {
    this.rng = new Prng(seed);
  }

  decide(request: DecisionRequest): DecisionResponse {
    const action =
      request.legalActions[this.rng.nextInt(request.legalActions.length)] ??
      request.legalActions[0];
    if (action === undefined) throw new Error('decision request with no legal actions');
    const targets: TargetChoice[] = (action.targets ?? []).map((slot) => ({
      slot: slot.slot,
      choice: slot.options[this.rng.nextInt(slot.options.length)] as string,
    }));
    const response: DecisionResponse = { requestId: request.requestId, actionId: action.id };
    if (targets.length > 0) response.targets = targets;
    return response;
  }
}

/** A scripted step: match a request (optionally) and answer it. */
export type ScriptedStep = (request: DecisionRequest) => DecisionResponse;

/**
 * Plays from an ordered script. Each `decide` consumes one step; running out throws —
 * scripted tests must account for every surfaced decision. Helpers below build steps.
 */
export class ScriptedDecisionProvider implements DecisionProvider {
  private readonly steps: ScriptedStep[];
  private cursor = 0;
  /** Requests answered so far — inspectable by tests. */
  readonly seen: DecisionRequest[] = [];

  constructor(steps: ScriptedStep[]) {
    this.steps = steps;
  }

  decide(request: DecisionRequest): DecisionResponse {
    this.seen.push(request);
    const step = this.steps[this.cursor++];
    if (step === undefined) {
      throw new Error(
        `script exhausted at decision ${this.seen.length}: [${request.decidingPlayer}] ${request.prompt} — options: ${request.legalActions.map((a) => a.description).join(' | ')}`,
      );
    }
    return step(request);
  }

  get remainingSteps(): number {
    return this.steps.length - this.cursor;
  }
}

/** Step: choose the action whose description matches, with first-legal targets. */
export function choose(pattern: RegExp | string, targets?: TargetChoice[]): ScriptedStep {
  return (request) => {
    const re = typeof pattern === 'string' ? undefined : pattern;
    const action = request.legalActions.find((a) =>
      re !== undefined ? re.test(a.description) : a.description.includes(pattern as string),
    );
    if (action === undefined) {
      throw new Error(
        `no legal action matching ${String(pattern)} — options: ${request.legalActions.map((a) => a.description).join(' | ')}`,
      );
    }
    const chosen = targets ?? firstTargets(request, action.id);
    const response: DecisionResponse = { requestId: request.requestId, actionId: action.id };
    if (chosen.length > 0) response.targets = chosen;
    return response;
  };
}

/** Step: always the first listed action (index 0 — "pass"/"keep"/"don't attack"). */
export function chooseFirst(): ScriptedStep {
  return (request) => {
    const action = request.legalActions[0];
    if (action === undefined) throw new Error('decision request with no legal actions');
    const targets = firstTargets(request, action.id);
    const response: DecisionResponse = { requestId: request.requestId, actionId: action.id };
    if (targets.length > 0) response.targets = targets;
    return response;
  };
}

/**
 * Drive an engine to completion: per-seat providers answer surfaced decisions.
 * `maxDecisions` guards against runaway loops in tests.
 * `onDecision` callback fires after each decision is submitted.
 */
export function runToCompletion(
  engine: Engine,
  providerFor: (playerId: string) => DecisionProvider,
  opts?: {
    maxDecisions?: number;
    onDecision?: (request: DecisionRequest, response: DecisionResponse) => void;
  },
): GameResult {
  const maxDecisions = typeof opts === 'number' ? opts : (opts?.maxDecisions ?? 100_000);
  const onDecision = typeof opts === 'object' ? opts?.onDecision : undefined;
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'gameOver') return step.result;
    if (step.kind === 'continue') continue;
    if (++decisions > maxDecisions) {
      throw new Error(`exceeded ${maxDecisions} surfaced decisions — runaway game?`);
    }
    const response = providerFor(step.request.decidingPlayer).decide(step.request);
    engine.submit(response);
    onDecision?.(step.request, response);
  }
}

export interface AsyncDecisionProvider {
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

/**
 * Drive an engine to completion: per-seat providers answer surfaced decisions asynchronously.
 * `maxDecisions` guards against runaway loops in tests.
 * `onDecision` callback fires after each decision is submitted (e.g. for persistence/logging).
 */
export async function runToCompletionAsync(
  engine: Engine,
  providerFor: (playerId: string) => AsyncDecisionProvider,
  opts?: {
    maxDecisions?: number;
    onDecision?: (request: DecisionRequest, response: DecisionResponse) => void;
  },
): Promise<GameResult> {
  const maxDecisions = opts?.maxDecisions ?? 100_000;
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'gameOver') return step.result;
    if (step.kind === 'continue') continue;
    if (++decisions > maxDecisions) {
      throw new Error(`exceeded ${maxDecisions} surfaced decisions — runaway game?`);
    }
    const response = await providerFor(step.request.decidingPlayer).decide(step.request);
    engine.submit(response);
    opts?.onDecision?.(step.request, response);
  }
}
