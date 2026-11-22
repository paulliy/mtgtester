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
import type { DecisionRequest, DecisionResponse, PlayerId, PlayerView } from '@mtg/shared';
import {
  decide as heuristicDecide,
  Rng as HeuristicRng,
  type DiplomacyPlay,
  type ScoredAction,
} from '@mtg/bot';
import type { AiConfig } from './config';
import type { AiClient, CallMeta } from './client';
import { assemblePrompt, type AiPrompt, type OpenAiMessage } from './context';
import { DecisionCache } from './decision-cache';
import { AiResponseValidationError } from './errors';
import { abilityFactsFrom, tryHeuristic } from './heuristics';
import {
  localCallMeta,
  type AiCallLogger,
  type BotComparison,
  type DecisionSource,
} from './logger';
import { validateResponse } from './validate';
import { StrategyCoordinator } from './strategy-coordinator';
import { preparePromptForCaching } from './prompt-cache';
import { routeStrategy } from './strategy-router';
import { DEFAULT_POLICY_REGISTRY, type PolicyRegistry } from './policy-registry';
import {
  sameResponse,
  type JevComparison,
  type JevPolicyBinding,
  type JevPolicyOutcome,
} from './jev-policy';
import { BotTactician, knowledgeFor, type BotAnswer } from './bot-tactician';
import { ESCALATION_TRIGGERS, type EscalationTrigger, type LiveEscalationTrigger } from './config';
import { attribute } from './escalation';

/**
 * Errors where falling back per-decision would be dishonest: the budget or the credentials
 * are gone, so every subsequent decision would silently become a fallback and the "game"
 * would finish having barely consulted the model. The caller reports these and stops.
 */
// Errors are caught and safely fallen back to safest legal action during playback.

export interface RequestQueueInterface {
  enqueue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
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

/** Choice instructions when Jev settles a bot close call between two options. */
export const JEV_CLOSE_CALL_INSTRUCTIONS =
  "Both actions are legal and were judged close. Choose the one that better advances this seat's stated strategy and survival. Select exactly one criterion key.";

/** Optional seams for bot-led tactics, used by bot-bench's `bot-led` kind (ADR 0043). */
export interface BotLedHooks {
  /** Tie-break seed label for this seat's bot; defaults to `<gameId>-<seat>-bot`. */
  botSeed?: string;
  /**
   * Called once per decision the bot-led tactician was consulted on, with whether the model was
   * asked and the escalation reasons that fired.
   */
  onBotDecision?: (
    request: DecisionRequest,
    outcome: { escalated: boolean; reasons: readonly string[]; escalatedBy?: string },
  ) => void;
  /** Called with each `BotComparison`, after the logger has it (for decision traces). */
  onBotComparison?: (comparison: BotComparison) => void;
}

/**
 * Per-trigger counts (ADR 0044 decision 5.2) for the call census: how often each trigger fired
 * (live or shadow), how many calls each live trigger was credited with, and on which decision
 * types and answer sources the shadow fired.
 */
export interface EscalationStats {
  fired: Record<EscalationTrigger, number>;
  escalated: Record<LiveEscalationTrigger, number>;
  /** `<trigger>:<decisionType>` → count. */
  byDecisionType: Record<string, number>;
  /** `<trigger>:<source>` → count; the source is `bot`, `plan`, `heuristic` or `cache`. */
  bySource: Record<string, number>;
}

function emptyStats(): EscalationStats {
  return {
    fired: Object.fromEntries(ESCALATION_TRIGGERS.map((t) => [t, 0])) as EscalationStats['fired'],
    escalated: { 'scarce-answer': 0, 'unknown-card': 0, uncertain: 0 },
    byDecisionType: {},
    bySource: {},
  };
}

export class OpenAiDecisionProvider implements AsyncDecisionProvider {
  /** Per-provider (therefore per-seat, per-game) — never shared between games. */
  private readonly cache = new DecisionCache();
  private readonly strategy: StrategyCoordinator;
  /** The deal context the current request's prompt was built from (ADR 0035). */
  private decisionContext: { requestId: string; context: string | undefined } | null = null;
  /** Bot-led tactics (ADR 0039), created on this seat's first decision in `bot` mode. */
  private botTactician: BotTactician | null = null;
  private readonly stats: EscalationStats = emptyStats();
  /** Which local path answered the current request: plan, heuristic or cache. */
  private lastLocalSource: 'plan' | 'heuristic' | 'cache' | null = null;
  /** The live trigger behind the current model call, stored with its cached answer. */
  private escalationReason: { requestId: string; reason: LiveEscalationTrigger } | null = null;

  constructor(
    private readonly client: AiClient,
    private readonly queue: RequestQueueInterface,
    private readonly engine: Engine,
    private readonly config: AiConfig,
    private readonly logger?: AiCallLogger,
    private readonly escalation?: DecisionEscalation,
    coordinator?: StrategyCoordinator,
    private readonly jev?: JevPolicyBinding,
    private readonly policyRegistry: PolicyRegistry = DEFAULT_POLICY_REGISTRY,
    /** Table deals for a seat (ADR 0035); bot-led tactics must honor them, not just log breaches. */
    private readonly diplomacyFor?: (seat: PlayerId) => DiplomacyPlay | undefined,
    private readonly botHooks: BotLedHooks = {},
  ) {
    this.strategy = coordinator ?? new StrategyCoordinator(null, queue, engine, config, logger);
  }

  /** Record a decision answered without a network call, so the savings are measurable. */
  private logLocal(
    request: DecisionRequest,
    response: DecisionResponse,
    source: DecisionSource,
  ): void {
    this.logger?.log(request, { response, meta: localCallMeta() }, false, false, source);
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    // Fire-and-forget: the strategist call is off the critical path (20-60s vs. this
    // decision's 3-4s). `guidanceFor`/`tryExecutePlan` read whatever has landed so far.
    this.strategy.prepare(request);
    // 1. Obtain hidden-information-safe view (brief §7.1 anti-cheat boundary). Local and
    //    cheap, and both short-circuits below read it, so it is built first either way.
    const view = this.engine.view(request.decidingPlayer);
    // The deals the prompt is built from. A seat decides one request at a time, so one slot is
    // enough; the answer is cached only if the deals are still the same when it lands.
    this.decisionContext = { requestId: request.requestId, context: this.cacheContext(request) };

    if (this.config.strategyRouterShadowEnabled) {
      const route = routeStrategy({
        role: 'tactician',
        request,
        view,
        registry: this.policyRegistry,
        shadowOnly: true,
      });
      this.engine.addDebug?.('decision', `shadow route: ${route.initialHandler}`, {
        routerVersion: route.version,
        initialHandler: route.initialHandler,
        finalHandler: route.finalHandler,
        reasons: route.reasons,
        featureDurationMs: route.featureDurationMs,
      });
    }

    const local = this.tryLocalAnswer(request, view);
    if (local !== null) {
      if (this.config.tacticalMode === 'bot') {
        const bot = this.botFor(request);
        // ADR 0044 decision 3.1: the shadow also sees answers the bot was never asked about.
        if (this.watchedTriggers().size > 0) {
          const source = this.lastLocalSource ?? 'plan';
          this.noteTriggers(request, bot.shadowTriggers(request, local), null, source);
        }
        bot.record(request, local);
      }
      return local;
    }

    if (this.config.tacticalMode === 'bot') {
      const bot = this.botFor(request);
      const answer = bot.decide(request);
      const escalatedBy = attribute(answer.reasons, this.config.botEscalation);
      const escalate = escalatedBy !== null;
      this.noteTriggers(request, answer.reasons, escalatedBy, 'bot');
      this.botHooks.onBotDecision?.(request, {
        escalated: escalate,
        reasons: answer.reasons,
        ...(escalatedBy !== null && { escalatedBy }),
      });
      if (!escalate) {
        bot.record(request, answer.response);
        this.logLocal(request, answer.response, 'bot');
        this.strategy.recordDecision(request, answer.response, 'bot');
        this.shadowJev(request, view, answer.response, 'bot', answer.uncertain);
        return answer.response;
      }
      this.engine.addDebug?.(
        'decision',
        `bot escalates ${request.requestId} (${escalatedBy}); asking the model`,
        { source: 'bot', escalatedBy, reasons: answer.reasons },
      );
      this.escalationReason = { requestId: request.requestId, reason: escalatedBy };
      const response = await this.decideViaModelOrFallback(request, view, answer, escalatedBy);
      bot.record(request, response);
      this.compareBot(request, response, answer.ranked, {
        kind: 'escalated',
        botResponse: answer.response,
        escalatedBy,
        reasons: answer.reasons,
      });
      return response;
    }

    const response = await this.decideViaModelOrFallback(request, view);
    if (this.config.botComparisonEnabled && this.logger !== undefined) {
      try {
        this.compareBot(request, response, this.botFor(request).shadowRank(request), {
          kind: 'shadow',
        });
      } catch {
        // Evidence collection must never stop a game.
      }
    }
    return response;
  }

  /**
   * Record the bot's choice beside a model-answered decision (`BotComparison`). Only answers the
   * model (or Jev) played count: a fallback is the bot itself, and a local answer asked nobody.
   */
  private compareBot(
    request: DecisionRequest,
    played: DecisionResponse,
    ranked: readonly ScoredAction[],
    detail:
      | {
          kind: 'escalated';
          botResponse: DecisionResponse;
          escalatedBy: string;
          reasons: readonly string[];
        }
      | { kind: 'shadow' },
  ): void {
    if (!this.config.botComparisonEnabled) return;
    const playedBy = this.logger?.sourceFor(request.requestId);
    if (playedBy !== 'primary' && playedBy !== 'retry' && playedBy !== 'jev') return;
    const botActionId =
      detail.kind === 'escalated' ? detail.botResponse.actionId : (ranked[0]?.action.id ?? null);
    const playedScore = ranked.find((entry) => entry.action.id === played.actionId)?.score;
    const comparison: BotComparison = {
      schemaVersion: 1,
      requestId: request.requestId,
      seat: request.decidingPlayer,
      turn: request.turn,
      decisionType: request.decisionType,
      kind: detail.kind,
      ...(detail.kind === 'escalated'
        ? { escalatedBy: detail.escalatedBy, reasons: [...detail.reasons] }
        : {}),
      playedBy,
      playedActionId: played.actionId,
      botActionId,
      botTop: ranked.slice(0, 3).map((entry) => ({
        actionId: entry.action.id,
        score: Math.round(entry.score * 100) / 100,
        description: entry.action.description,
      })),
      ...(playedScore === undefined ? {} : { playedBotScore: Math.round(playedScore * 100) / 100 }),
      sameAction: botActionId === played.actionId,
      ...(detail.kind === 'escalated'
        ? { agreed: sameResponse(detail.botResponse, played, request) }
        : {}),
    };
    this.logger?.recordBotComparison(comparison);
    this.botHooks.onBotComparison?.(comparison);
  }

  /** Live and shadow triggers this seat evaluates; empty means the trigger code never runs. */
  private watchedTriggers(): Set<EscalationTrigger> {
    return new Set<EscalationTrigger>([
      ...this.config.botEscalation,
      ...this.config.botEscalationShadow,
    ]);
  }

  /**
   * Log the watched triggers that fired (ADR 0044 decision 5.2): a debug entry beside the strategy
   * router's shadow, and the per-reason counters the call census reads. A shadow trigger never
   * claims a live trigger's call; it is logged beside it.
   */
  private noteTriggers(
    request: DecisionRequest,
    reasons: readonly EscalationTrigger[],
    escalatedBy: LiveEscalationTrigger | null,
    source: string,
  ): void {
    const watched = this.watchedTriggers();
    const fired = reasons.filter((reason) => watched.has(reason));
    if (escalatedBy !== null) this.stats.escalated[escalatedBy]++;
    if (fired.length === 0) return;
    for (const reason of fired) {
      this.stats.fired[reason]++;
      const byType = `${reason}:${request.decisionType}`;
      this.stats.byDecisionType[byType] = (this.stats.byDecisionType[byType] ?? 0) + 1;
      const bySource = `${reason}:${source}`;
      this.stats.bySource[bySource] = (this.stats.bySource[bySource] ?? 0) + 1;
    }
    const shadow = fired.filter(
      (reason) => !(this.config.botEscalation as readonly string[]).includes(reason),
    );
    this.engine.addDebug?.(
      'decision',
      `escalation triggers for ${request.requestId}: ${fired.join(', ')}`,
      {
        source,
        decisionType: request.decisionType,
        fired,
        shadow,
        escalatedBy,
      },
    );
  }

  /** A copy of this seat's trigger counts (ADR 0044's call census). */
  escalationStats(): EscalationStats {
    return structuredClone(this.stats);
  }

  /**
   * Shadow Jev (ADR 0041): ask Jev about a decision another answerer already settled, without
   * waiting, and record whether it would have agreed. Never changes play.
   */
  private shadowJev(
    request: DecisionRequest,
    view: PlayerView,
    played: DecisionResponse,
    playedBy: JevComparison['playedBy'],
    botUncertain?: boolean,
  ): void {
    const jev = this.jev;
    if (jev === undefined || jev.mode !== 'shadow') return;
    if (this.config.jevShadowScope === 'uncertain' && botUncertain !== true) return;
    void jev.policy
      .decide(request, view, this.strategy.guidanceFor(request.decidingPlayer, request, view))
      .then((outcome) => {
        this.recordJevDebug(request, outcome, true);
        this.compareJev(request, outcome, played, playedBy, botUncertain);
      })
      .catch((error: unknown) => {
        this.engine.addDebug?.('decision', `Jev shadow failed for ${request.requestId}`, {
          mode: 'shadow',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private compareJev(
    request: DecisionRequest,
    outcome: JevPolicyOutcome,
    played: DecisionResponse,
    playedBy: JevComparison['playedBy'],
    botUncertain?: boolean,
  ): void {
    const observer = this.jev?.onComparison;
    if (observer === undefined) return;
    const jevResponse =
      outcome.kind === 'answered'
        ? outcome.response
        : outcome.adaptation?.kind === 'accepted'
          ? outcome.adaptation.response
          : undefined;
    const confidence =
      outcome.kind === 'answered'
        ? outcome.confidence
        : outcome.adaptation?.kind === 'accepted'
          ? outcome.adaptation.confidence
          : null;
    const margin =
      outcome.kind === 'answered'
        ? outcome.topTwoMargin
        : outcome.adaptation?.kind === 'accepted'
          ? outcome.adaptation.topTwoMargin
          : null;
    try {
      observer({
        schemaVersion: 1,
        logicalRequestId: request.requestId,
        seat: request.decidingPlayer,
        turn: request.turn,
        decisionType: request.decisionType,
        playedBy,
        playedActionId: played.actionId,
        ...(botUncertain === undefined ? {} : { botUncertain }),
        jevOutcome: outcome.kind === 'answered' ? 'answered' : outcome.reason,
        ...(jevResponse === undefined
          ? {}
          : {
              jevActionId: jevResponse.actionId,
              agreed: sameResponse(jevResponse, played, request),
              sameAction: jevResponse.actionId === played.actionId,
            }),
        ...(confidence === null ? {} : { confidence }),
        ...(margin === null ? {} : { topTwoMargin: margin }),
      });
    } catch {
      // Evidence collection must never stop a game.
    }
  }

  /**
   * Jev (when bound), then the tactician model, then escalation or the fallback bot. With
   * `jevFallback: 'bot'`, a decision Jev was asked but did not settle goes to the bot instead of
   * the model; `botAnswer` is the bot's answer when the caller already has it.
   */
  private async decideViaModelOrFallback(
    request: DecisionRequest,
    view: PlayerView,
    botAnswer?: BotAnswer,
    escalatedBy?: LiveEscalationTrigger,
  ): Promise<DecisionResponse> {
    let shadow: Promise<JevPolicyOutcome> | undefined;
    let fellThrough: JevPolicyOutcome | undefined;
    // ADR 0044 decision 5.4: Jev settles close calls from the bot's top two options. For
    // `scarce-answer` and `unknown-card` the option that matters (usually pass) need not be in the
    // top two, so they go to the model until a pair is defined for each.
    const skipJev =
      escalatedBy !== undefined && escalatedBy !== 'uncertain' && this.jev?.mode !== 'shadow';
    if (this.jev !== undefined && !skipJev) {
      const guidance = this.strategy.guidanceFor(request.decidingPlayer, request, view);
      if (this.jev.mode === 'shadow') {
        if (this.config.jevShadowScope === 'all' || botAnswer?.uncertain === true) {
          shadow = this.jev.policy.decide(request, view, guidance);
        }
      } else {
        const pair = this.closeCallPair(request, botAnswer);
        const jev =
          pair === null
            ? await this.jev.policy.decide(request, view, guidance)
            : await this.jev.policy.decide(pair, view, guidance, {
                instructions: JEV_CLOSE_CALL_INSTRUCTIONS,
                ignoreThresholds: true,
              });
        this.recordJevDebug(request, jev, false);
        if (jev.kind === 'answered') {
          this.logger?.log(
            request,
            { response: jev.response, meta: jev.meta },
            false,
            false,
            'jev',
          );
          this.rememberAnswer(request, view, jev.response);
          this.strategy.recordDecision(request, jev.response, 'jev');
          return jev.response;
        }
        if (jev.reason === 'cancelled') throw new Error('Jev request cancelled');
        fellThrough = jev;
        if (this.config.jevFallback === 'bot') {
          const answer = botAnswer ?? this.botFor(request).decide(request);
          // In bot mode the caller records the final answer; in model mode nobody else will.
          if (botAnswer === undefined) this.botFor(request).record(request, answer.response);
          this.logLocal(request, answer.response, 'bot');
          this.strategy.recordDecision(request, answer.response, 'bot');
          this.compareJev(request, jev, answer.response, 'bot', botAnswer?.uncertain);
          return answer.response;
        }
      }
    }

    const { response, playedBy } = await this.decideViaModelChain(request, view);
    if (fellThrough !== undefined) {
      this.compareJev(request, fellThrough, response, playedBy, botAnswer?.uncertain);
    }
    if (shadow !== undefined) {
      void shadow
        .then((outcome) => {
          this.recordJevDebug(request, outcome, true);
          this.compareJev(request, outcome, response, playedBy, botAnswer?.uncertain);
        })
        .catch((error: unknown) => {
          this.engine.addDebug?.('decision', `Jev shadow failed for ${request.requestId}`, {
            mode: 'shadow',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return response;
  }

  /**
   * A bot close call narrowed to the bot's two best options (`jevCloseCallMenu: 'top2'`), or null
   * to ask Jev about the whole menu. Both options are still the engine's own legal actions.
   */
  private closeCallPair(
    request: DecisionRequest,
    botAnswer: BotAnswer | undefined,
  ): DecisionRequest | null {
    if (this.config.jevCloseCallMenu !== 'top2' || botAnswer?.uncertain !== true) return null;
    const ids = botAnswer.topActionIds ?? [];
    if (ids.length !== 2) return null;
    const legalActions = request.legalActions.filter((action) => ids.includes(action.id));
    return legalActions.length === 2 ? { ...request, legalActions } : null;
  }

  /** The tactician model, then escalation or the fallback bot. */
  private async decideViaModelChain(
    request: DecisionRequest,
    view: PlayerView,
  ): Promise<{ response: DecisionResponse; playedBy: 'model' | 'fallback' }> {
    let failure: ModelFailure;
    try {
      const outcome = await this.decideViaModel(request, view);
      if (outcome.kind === 'answered') return { response: outcome.response, playedBy: 'model' };
      failure = outcome;
    } catch (err) {
      console.warn(
        `  ⚠ ${request.decidingPlayer} decision ${request.requestId} failed (${(err as Error).message.slice(0, 120)}) — using fallback`,
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
    return {
      response: await this.escalateOrFallback(request, view, failure),
      playedBy: 'fallback',
    };
  }

  private botFor(request: DecisionRequest): BotTactician {
    if (this.botTactician === null) {
      const seat = request.decidingPlayer;
      this.botTactician = new BotTactician(
        this.engine,
        seat,
        request.gameId,
        () => this.strategy.steeringFor(seat),
        this.config.botEscalationMargin,
        this.diplomacyFor?.(seat),
        this.botHooks.botSeed,
      );
    }
    return this.botTactician;
  }

  private recordJevDebug(
    request: DecisionRequest,
    outcome: JevPolicyOutcome,
    shadow: boolean,
  ): void {
    this.engine.addDebug?.(
      'decision',
      `Jev ${outcome.kind === 'answered' ? 'action accepted' : 'fell through'} for ${request.requestId}${shadow ? ' (shadow)' : ''}`,
      {
        mode: shadow ? 'shadow' : 'active',
        shape: outcome.classification.shape,
        ...(outcome.kind === 'answered'
          ? {
              confidence: outcome.confidence,
              topTwoMargin: outcome.topTwoMargin,
              probabilities: outcome.probabilities,
            }
          : { reason: outcome.reason, detail: outcome.detail }),
      },
    );
  }

  /**
   * §7.7 step 2 when a human is watching, step 3 otherwise. The step 3 fallback is the
   * heuristic bot (ADR 0023 item 9), not a reflex to pass: it scores every legal action for
   * `view` and takes whichever one actually comes out ahead, which is `pass` only when passing
   * genuinely is the best option at this decision. Ties break through a seeded `Rng` keyed on
   * the request id, so the same failed decision always resolves the same way.
   */
  private async escalateOrFallback(
    request: DecisionRequest,
    view: PlayerView,
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
        this.strategy.recordDecision(request, human, 'human');
        return human;
      }
    }

    // Seeded from the public request id, so it reveals nothing about a table game's keyed streams.
    // Card-aware, like bot-led mode and a table's bot seats: one bot wherever it plays (ADR 0043).
    const fallback = heuristicDecide(request, view, new HeuristicRng(request.requestId), {
      knowledge: knowledgeFor(this.engine),
    });
    console.warn(
      `  ⚠ ${request.decidingPlayer} decision ${request.requestId} — using heuristic bot fallback`,
    );
    this.logger?.log(
      request,
      { response: fallback, meta: { ...failure.meta, wasRetry: true, wasFallback: true } },
      true,
      true,
      'fallback',
    );
    this.strategy.recordDecision(request, fallback, 'fallback');
    return fallback;
  }

  /**
   * The model half of the §7.7 chain: primary attempt → corrective retry. Reports failure by
   * returning it rather than throwing, so the caller decides between escalation and fallback.
   */
  private async decideViaModel(request: DecisionRequest, view: PlayerView): Promise<ModelOutcome> {
    const assembledPrompt = assemblePrompt(
      request,
      view,
      this.strategy.guidanceFor(request.decidingPlayer, request, view),
      {
        includeMemory: this.config.contextMemoryEnabled,
        includeFeatures: this.config.contextFeaturesEnabled,
        useBudgeter: this.config.contextBudgeterEnabled,
        useCardSummaries: this.config.contextCardSummariesEnabled,
        inputTokenBudget: this.config.contextInputTokenBudget,
      },
    );
    const prompt = this.config.providerPromptCacheLayoutEnabled
      ? preparePromptForCaching(assembledPrompt, { role: 'tactician' })
      : assembledPrompt;

    this.engine.addDebug?.(
      'decision',
      `API call initiated for ${request.decidingPlayer} (${request.requestId})`,
      { requestId: request.requestId, decidingPlayer: request.decidingPlayer },
    );

    // 2. Primary attempt. A response the client could not read at all (truncated JSON, prose,
    //    an empty completion) is exactly what step 1 exists for, so it takes the corrective
    //    retry rather than falling straight through to the safest legal action.
    let result;
    try {
      result = await this.queue.enqueue(() => this.client.requestDecision(prompt, request));
    } catch (err) {
      if (!(err instanceof AiResponseValidationError)) throw err;
      return await this.correctiveRetry(request, view, prompt, err.rawResponse ?? '', err.details);
    }

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
      this.strategy.recordDecision(request, result.response, 'primary');
      return { kind: 'answered', response: result.response };
    }

    // 3. Retry once with corrective message (§7.7 step 1)
    return await this.correctiveRetry(request, view, prompt, result.meta.rawResponse, error1);
  }

  /**
   * §7.7 step 1: show the model its own rejected answer and the menu again, once. Reached from
   * two places — a response that parsed but chose something illegal, and a response that never
   * parsed at all — because from the model's side they are the same mistake.
   */
  private async correctiveRetry(
    request: DecisionRequest,
    view: PlayerView,
    prompt: AiPrompt,
    rejected: string,
    error: string,
  ): Promise<ModelOutcome> {
    const correctiveMessages: OpenAiMessage[] = [
      ...prompt.messages,
      { role: 'assistant', content: rejected },
      {
        role: 'user',
        content: `Validation error: ${error}.\nPlease choose a valid actionId from this legal actions menu:\n${JSON.stringify(request.legalActions, null, 2)}\nReturn ONLY the JSON response object.`,
      },
    ];

    const retryPrompt = { ...prompt, messages: correctiveMessages };
    let retryResult;
    try {
      retryResult = await this.queue.enqueue(() =>
        this.client.requestDecision(retryPrompt, request),
      );
    } catch (err) {
      if (!(err instanceof AiResponseValidationError)) throw err;
      return {
        kind: 'failed',
        detail: err.details,
        meta: { ...localCallMeta(), wasRetry: true, rawResponse: err.rawResponse ?? '' },
      };
    }

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
      this.strategy.recordDecision(request, retryResult.response, 'retry');
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
  private tryLocalAnswer(request: DecisionRequest, view: PlayerView): DecisionResponse | null {
    this.lastLocalSource = null;
    // Check pre-planned turn actions first
    const planned = this.strategy.tryExecutePlan(request);
    if (planned !== null) {
      this.lastLocalSource = 'plan';
      this.logLocal(request, planned, 'plan');
      this.strategy.recordDecision(request, planned, 'plan');
      return planned;
    }

    if (this.config.heuristicsEnabled) {
      // Rule D only saves model calls; in bot-led mode the bot answers those windows for free.
      const heuristic = tryHeuristic(
        request,
        view,
        this.config.tacticalMode === 'model'
          ? abilityFactsFrom(knowledgeFor(this.engine))
          : undefined,
      );
      if (heuristic !== null) {
        this.lastLocalSource = 'heuristic';
        this.engine.addDebug?.(
          'decision',
          `decision answered locally for ${request.decidingPlayer} via heuristic: ${heuristic.note ?? ''}`,
          { source: 'heuristic' },
        );
        this.logLocal(request, heuristic, 'heuristic');
        this.strategy.recordDecision(request, heuristic, 'heuristic');
        return heuristic;
      }
    }

    if (this.config.decisionCacheEnabled) {
      const entry = this.cache.lookup(request, view, this.cacheContext(request));
      if (entry !== null) {
        const cached = entry.response;
        this.lastLocalSource = 'cache';
        // ADR 0044 decision 5.5: a replayed escalated answer says why it was first escalated, so
        // it is not mistaken for the bot's own.
        this.engine.addDebug?.(
          'decision',
          `decision answered locally for ${request.decidingPlayer} via cache: ${cached.note ?? ''}` +
            (entry.escalation === undefined
              ? ''
              : ` (replaying an answer escalated by ${entry.escalation})`),
          {
            source: 'cache',
            ...(entry.escalation !== undefined && { escalation: entry.escalation }),
          },
        );
        this.logLocal(request, cached, 'cache');
        this.strategy.recordDecision(request, cached, 'cache');
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
    if (!this.config.decisionCacheEnabled) return;
    const context = this.cacheContext(request);
    const asked = this.decisionContext;
    // A deal made while the model was thinking: the answer never saw it, so it is not cached
    // under either key.
    if (asked?.requestId === request.requestId && asked.context !== context) return;
    const escalation =
      this.escalationReason?.requestId === request.requestId
        ? this.escalationReason.reason
        : undefined;
    this.cache.set(request, view, response, context, escalation);
  }

  /**
   * The seat's deals as its prompt shows them (ADR 0035): an answer given before a deal was made
   * must not be replayed after it, so they are part of the cache key. Undefined without deals.
   */
  private cacheContext(request: DecisionRequest): string | undefined {
    const deals = this.strategy.diplomacyFor?.(request.decidingPlayer, 'tactician') ?? null;
    return deals === null ? undefined : JSON.stringify(deals);
  }
}
