/**
 * OpenAI Decision Provider (§7.3, §7.7).
 * Implements `AsyncDecisionProvider` with the 3-step error recovery chain:
 * 1. Primary AI attempt
 * 2. Single retry with validation error feedback and restated menu
 * 3. Safest conservative legal action fallback
 *
 * Ahead of all three sits a local short-circuit pair — a heuristic for dominated decisions and
 * a cache for decisions already answered in an identical state. Both run *before*
 * `queue.enqueue`, which is what meters RPM, so a decision they answer costs nothing against
 * the rate limit and the game reaches further into the turn sequence on the same budget.
 */

import type { AsyncDecisionProvider, Engine } from '@mtg/engine';
import type { DecisionRequest, DecisionResponse, PlayerView } from '@mtg/shared';
import type { AiConfig } from './config';
import type { AiClient, CallMeta } from './client';
import { assemblePrompt, type OpenAiMessage } from './context';
import { DecisionCache } from './decision-cache';
import {
  AuthenticationError,
  DailyQuotaExhaustedError,
  NoAvailableModelError,
} from './errors';
import { safestFallback } from './fallback';
import { tryHeuristic } from './heuristics';
import { localCallMeta, type AiCallLogger, type DecisionSource } from './logger';
import { validateResponse } from './validate';

import { TurnPlanManager } from './turn-plan';

/**
 * Errors where falling back per-decision would be dishonest: the budget or the credentials
 * are gone, so every subsequent decision would silently become a fallback and the "game"
 * would finish having barely consulted the model. The caller reports these and stops.
 */
function isTerminalAiError(err: unknown): boolean {
  return (
    err instanceof DailyQuotaExhaustedError ||
    err instanceof NoAvailableModelError ||
    err instanceof AuthenticationError
  );
}

export interface RequestQueueInterface {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Step 2 of §7.7 — "pause and surface the choice to the user" — which the provider on its own
 * has no way to do: it does not know whether a human is watching. Phase 4's `MatchRunner`
 * supplies this and answers that question (ADR 0012 §5).
 *
 * Returning `null` restores the safest-fallback path. Throwing halts the match, which is what
 * the runner does when this decision is compute-ahead running past the viewer — brief §7.7:
 * problematic states are never resolved unsupervised.
 *
 * Absent (the CLI paths), the chain behaves exactly as it did in Phase 3.
 */
export interface DecisionEscalation {
  onModelFailed(request: DecisionRequest, detail: string): Promise<DecisionResponse | null>;
}

/** The model produced nothing usable. `meta` carries the tokens the failed attempts still cost. */
interface ModelFailure {
  kind: 'failed';
  detail: string;
  meta: CallMeta;
}

type ModelOutcome = { kind: 'answered'; response: DecisionResponse } | ModelFailure;

export class OpenAiDecisionProvider implements AsyncDecisionProvider {
  /** Per-provider (therefore per-seat, per-game) — never shared between games. */
  private readonly cache = new DecisionCache();
  private readonly turnPlan = new TurnPlanManager();

  constructor(
    private readonly client: AiClient,
    private readonly queue: RequestQueueInterface,
    private readonly engine: Engine,
    private readonly config: AiConfig,
    private readonly logger?: AiCallLogger,
    private readonly escalation?: DecisionEscalation,
  ) {}

  /** Record a decision answered without a network call, so the savings are measurable. */
  private logLocal(
    request: DecisionRequest,
    response: DecisionResponse,
    source: DecisionSource,
  ): void {
    this.logger?.log(request, { response, meta: localCallMeta() }, false, false, source);
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    // 1. Obtain hidden-information-safe view (brief §7.1 anti-cheat boundary). Local and
    //    cheap, and both short-circuits below read it, so it is built first either way.
    const view = this.engine.view(request.decidingPlayer);

    const local = this.tryLocalAnswer(request, view);
    if (local !== null) return local;

    let failure: ModelFailure;
    try {
      const outcome = await this.decideViaModel(request, view);
      if (outcome.kind === 'answered') return outcome.response;
      failure = outcome;
    } catch (err) {
      // §7.7's recovery applies to ANY way the model failed to produce a usable answer, not
      // just a response that arrived and failed validation. A request that never came back at
      // all — a provider rejecting its own malformed JSON, a transient 5xx surviving its
      // retries — used to propagate and end the game outright. Only conditions where the game
      // genuinely cannot continue are allowed past here.
      if (isTerminalAiError(err)) throw err;

      console.warn(
        `  ⚠ ${request.decidingPlayer} decision ${request.requestId} failed (${(err as Error).message.slice(0, 120)})`,
      );
      failure = {
        kind: 'failed',
        detail: (err as Error).message,
        meta: { ...localCallMeta(), rawResponse: String(err) },
      };
    }

    // Escalation is invoked here, OUTSIDE the try, on purpose: the runner signals "this is
    // compute-ahead, halt the match" by throwing, and that throw must reach the caller rather
    // than be caught above and quietly downgraded into the fallback it exists to prevent.
    return await this.escalateOrFallback(request, failure);
  }

  /**
   * §7.7 step 2 when a human is watching, step 3 otherwise. Without an escalation hook this is
   * exactly the Phase 3 behaviour: safest legal action, logged prominently as a fallback.
   */
  private async escalateOrFallback(
    request: DecisionRequest,
    failure: ModelFailure,
  ): Promise<DecisionResponse> {
    if (this.escalation !== undefined) {
      const human = await this.escalation.onModelFailed(request, failure.detail);
      if (human !== null) {
        this.logger?.log(
          request,
          { response: human, meta: { ...failure.meta, wasRetry: true } },
          true,
          false,
          'human',
        );
        this.turnPlan.recordDecision(request, human, 'human', this.engine);
        return human;
      }
    }

    const fallback = safestFallback(request);
    console.warn(
      `  ⚠ ${request.decidingPlayer} decision ${request.requestId} — using safest legal action`,
    );
    this.logger?.log(
      request,
      { response: fallback, meta: { ...failure.meta, wasRetry: true, wasFallback: true } },
      true,
      true,
      'fallback',
    );
    this.turnPlan.recordDecision(request, fallback, 'fallback', this.engine);
    return fallback;
  }

  /**
   * The model half of the §7.7 chain: primary attempt → corrective retry. Reports failure by
   * returning it rather than throwing, so the caller decides between escalation and fallback.
   */
  private async decideViaModel(
    request: DecisionRequest,
    view: PlayerView,
  ): Promise<ModelOutcome> {
    const prompt = assemblePrompt(request, view);

    this.engine.addDebug?.(
      'decision',
      `API call initiated for ${request.decidingPlayer} (${request.requestId})`,
      { requestId: request.requestId, decidingPlayer: request.decidingPlayer },
    );

    // 2. Primary attempt
    const result = await this.queue.enqueue(() =>
      this.client.requestDecision(prompt, request),
    );

    this.engine.addDebug?.(
      'decision',
      `API call completed for ${request.decidingPlayer} (${request.requestId}) [model: ${result.meta.model}, latency: ${result.meta.latencyMs}ms, tokens: ${result.meta.promptTokens}+${result.meta.responseTokens}]`,
      {
        requestId: request.requestId,
        model: result.meta.model,
        latencyMs: result.meta.latencyMs,
        tokens: { prompt: result.meta.promptTokens, response: result.meta.responseTokens },
      },
    );

    const error1 = validateResponse(result.response, request);
    if (error1 === null) {
      this.logger?.log(request, result, false, false, 'primary');
      this.rememberAnswer(request, view, result.response);
      this.turnPlan.recordDecision(request, result.response, 'primary', this.engine);
      return { kind: 'answered', response: result.response };
    }

    // 3. Retry once with corrective message (§7.7 step 1)
    const correctiveMessages: OpenAiMessage[] = [
      ...prompt.messages,
      { role: 'assistant', content: result.meta.rawResponse },
      {
        role: 'user',
        content: `Validation error: ${error1}.\nPlease choose a valid actionId from this legal actions menu:\n${JSON.stringify(request.legalActions, null, 2)}\nReturn ONLY the JSON response object.`,
      },
    ];

    const retryPrompt = { ...prompt, messages: correctiveMessages };
    const retryResult = await this.queue.enqueue(() =>
      this.client.requestDecision(retryPrompt, request),
    );

    const error2 = validateResponse(retryResult.response, request);
    if (error2 === null) {
      this.logger?.log(
        request,
        { ...retryResult, meta: { ...retryResult.meta, wasRetry: true } },
        true,
        false,
        'retry',
      );
      this.rememberAnswer(request, view, retryResult.response);
      this.turnPlan.recordDecision(request, retryResult.response, 'retry', this.engine);
      return { kind: 'answered', response: retryResult.response };
    }

    // 4. Both attempts failed. The caller decides between the human override (§7.7 step 2) and
    //    the safest legal action (§7.7 step 3). Neither is cached: what we do when the model
    //    failed us is not a decision worth replaying for free.
    return {
      kind: 'failed',
      detail: error2,
      meta: { ...retryResult.meta, wasRetry: true },
    };
  }

  /**
   * Answer without the network if we can: turn plan execution, heuristics for dominated
   * decisions, then a cache for a decision already made in this exact state.
   * Returns `null` when the decision is a real one and must be sent to the model.
   */
  private tryLocalAnswer(
    request: DecisionRequest,
    view: PlayerView,
  ): DecisionResponse | null {
    // Check pre-planned turn actions first
    const planned = this.turnPlan.tryExecutePlan(request, this.engine);
    if (planned !== null) {
      this.logLocal(request, planned, 'plan');
      this.turnPlan.recordDecision(request, planned, 'plan', this.engine);
      return planned;
    }

    if (this.config.heuristicsEnabled) {
      const heuristic = tryHeuristic(request, view);
      if (heuristic !== null) {
        this.engine.addDebug?.(
          'decision',
          `decision answered locally for ${request.decidingPlayer} via heuristic: ${heuristic.note ?? ''}`,
          { source: 'heuristic' },
        );
        this.logLocal(request, heuristic, 'heuristic');
        this.turnPlan.recordDecision(request, heuristic, 'heuristic', this.engine);
        return heuristic;
      }
    }

    if (this.config.decisionCacheEnabled) {
      const cached = this.cache.get(request, view);
      if (cached !== null) {
        this.engine.addDebug?.(
          'decision',
          `decision answered locally for ${request.decidingPlayer} via cache: ${cached.note ?? ''}`,
          { source: 'cache' },
        );
        this.logLocal(request, cached, 'cache');
        this.turnPlan.recordDecision(request, cached, 'cache', this.engine);
        return cached;
      }
    }

    return null;
  }

  private rememberAnswer(
    request: DecisionRequest,
    view: PlayerView,
    response: DecisionResponse,
  ): void {
    if (this.config.decisionCacheEnabled) this.cache.set(request, view, response);
  }
}
