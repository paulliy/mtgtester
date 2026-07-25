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
import type { AiClient } from './client';
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

    try {
      return await this.decideViaModel(request, view);
    } catch (err) {
      // §7.7 step 3 applies to ANY way the model failed to produce a usable answer, not just
      // a response that arrived and failed validation. A request that never came back at all
      // — a provider rejecting its own malformed JSON, a transient 5xx surviving its retries —
      // used to propagate and end the game outright. Only conditions where the game genuinely
      // cannot continue are allowed past here.
      if (isTerminalAiError(err)) throw err;

      const fallback = safestFallback(request);
      console.warn(
        `  ⚠ ${request.decidingPlayer} decision ${request.requestId} failed (${(err as Error).message.slice(0, 120)}) — using safest legal action`,
      );
      this.logger?.log(
        request,
        {
          response: fallback,
          meta: { ...localCallMeta(), wasRetry: true, wasFallback: true, rawResponse: String(err) },
        },
        true,
        true,
        'fallback',
      );
      this.turnPlan.recordDecision(request, fallback, 'fallback');
      return fallback;
    }
  }

  /** The full §7.7 chain against the model: primary → corrective retry → safest fallback. */
  private async decideViaModel(
    request: DecisionRequest,
    view: PlayerView,
  ): Promise<DecisionResponse> {
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
      return result.response;
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
      return retryResult.response;
    }

    // 4. Safest legal action fallback (§7.7 step 3). Deliberately NOT cached: it is what we
    //    do when the model failed us, not a decision we want to keep replaying for free.
    const fallback = safestFallback(request);
    this.logger?.log(
      request,
      {
        response: fallback,
        meta: {
          ...retryResult.meta,
          wasRetry: true,
          wasFallback: true,
        },
      },
      true,
      true,
      'fallback',
    );
    this.turnPlan.recordDecision(request, fallback, 'fallback', this.engine);

    return fallback;
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
