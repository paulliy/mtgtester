import type { Engine } from '@mtg/engine';
import type {
  BotSteering,
  DecisionRequest,
  DecisionResponse,
  GameId,
  PlanPrecondition,
  PlannedSourceReference,
  PlayerId,
  Phase,
  PlannedAction,
  Step,
  TurnStrategy,
} from '@mtg/shared';
import type { AiClient } from './client';
import type { AiConfig } from './config';
import { type RecentSeatDecision, type TacticalGuidance } from './context';
import { assembleStrategistPrompt } from './strategy-context';
import { RequestCancelledError } from './errors';
import type { AiCallLogger, DecisionSource } from './logger';
import type { StrategyProfile } from '../decks/strategy-profile';
import { PublicMemoryTracker } from './public-memory';
import { observationHash, type PlanArtifactMetadata } from './plan-lifecycle';
import { extractStateFeatures } from './state-features';
import { TurnPlanManager, type AcceptedPlanAction } from './turn-plan';
import { AI_VERSIONS } from './versions';
import type { SeatDiplomacyContext } from './diplomacy-context';
import { preparePromptForCaching } from './prompt-cache';
import { deltaBaseFrom, type StrategistDeltaBase } from './strategist-delta';
import {
  cleanSteering,
  tableChangeReasons,
  tableChanged,
  tableSnapshot,
  type TableSnapshot,
} from './steering';

interface QueueLike {
  enqueue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

const PHASES = new Set<Phase>(['beginning', 'precombatMain', 'combat', 'postcombatMain', 'ending']);

const STEPS = new Set<Step>([
  'untap',
  'upkeep',
  'draw',
  'beginCombat',
  'declareAttackers',
  'declareBlockers',
  'firstStrikeCombatDamage',
  'combatDamage',
  'endCombat',
  'end',
  'cleanup',
]);

/**
 * Ceiling on a seat's whole-game decision digest (ADR 0022 §7). `recentBySeat` is capped at
 * `strategyRecentDecisionLimit` (8) because a tactician only needs the last few moves; a post-game
 * review needs the arc of the game, which 8 cannot carry.
 */
const DIGEST_LIMIT = 80;

/** Combat is where games are decided, so it keeps more per turn than a main phase does. */
const DIGEST_COMBAT_PER_TURN = 3;

/** A pass is the absence of a decision. Keeping them would fill the digest with nothing. */
const DIGEST_SKIP_TYPES: ReadonlySet<string> = new Set([
  'pass',
  'passAndYieldTurn',
  'yieldToAbility',
]);

/**
 * Halve the resolution of the older half rather than dropping the front of the list. Truncating
 * the front is the obvious move and the wrong one: a review that cannot see the early game can
 * only ever comment on the endgame, and "what did I do wrong" is usually a turn-3 question.
 */
function thinDigest(list: RecentSeatDecision[]): RecentSeatDecision[] {
  if (list.length <= DIGEST_LIMIT) return list;
  const half = Math.floor(list.length / 2);
  return list.filter((_, index) => index >= half || index % 2 === 0);
}

/** Longest tactician-request reason kept: it may name cards in hand, so it stays short. */
export const TACTICIAN_REQUEST_REASON_LIMIT = 160;

/**
 * The strategist's typed tactician request (ADR 0045 decision 5.1), read from the raw answer on
 * its own: an answer whose knobs are all invalid stores no steering, but its request still counts.
 */
export function readTacticianRequest(raw: unknown): { reason: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const request = (raw as { tacticianRequest?: unknown }).tacticianRequest;
  if (typeof request !== 'object' || request === null) return null;
  const reason = (request as { reason?: unknown }).reason;
  if (typeof reason !== 'string' || reason.trim() === '') return null;
  return { reason: reason.trim().slice(0, TACTICIAN_REQUEST_REASON_LIMIT) };
}

/** One shadow tactician request, for the study (ADR 0045 decision 5.3). */
export interface TacticianRequestRecord {
  turn: number;
  seat: PlayerId;
  /** Private: the debug log and the study only. */
  reason: string;
  /**
   * What would have woken the strategist under `onChange` since the seat's previous knobs: `first
   * knobs`, `reuse limit`, or the table changes (`P2 life`, ...). Empty means `onChange` would
   * have reused the old knobs and made no call, so production would never have seen this request.
   */
  wake: string[];
  /** Whether the same answer also carried usable knobs. */
  knobs: boolean;
}

function cleanPlan(
  raw: TurnStrategy | undefined,
  steeringRules: { opponents: readonly PlayerId[]; botLed: boolean },
): TurnStrategy | null {
  if (raw === undefined || typeof raw.intent !== 'string') return null;
  // Model-written knobs are cleaned here, once, so nothing unbounded rides along on the plan
  // into later tactician prompts.
  const steering = steeringRules.botLed
    ? cleanSteering(raw.steering, steeringRules.opponents)
    : null;
  // A knobs-only answer (bot-led mode, ADR 0039) has no action list; anything else must.
  const rawActions = Array.isArray(raw.plannedActions)
    ? raw.plannedActions
    : steering !== null
      ? []
      : null;
  if (rawActions === null) return null;

  const plannedActions: PlannedAction[] = [];
  for (const candidate of rawActions.slice(0, 16)) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate.type !== 'string' ||
      candidate.type.length === 0
    ) {
      continue;
    }
    const action: PlannedAction = { type: candidate.type };
    if (typeof candidate.name === 'string') action.name = candidate.name;
    if (typeof candidate.description === 'string') action.description = candidate.description;
    if (candidate.phase !== undefined && PHASES.has(candidate.phase)) {
      action.phase = candidate.phase;
    }
    if (candidate.step === null || (candidate.step !== undefined && STEPS.has(candidate.step))) {
      action.step = candidate.step;
    }
    if (Array.isArray(candidate.targets)) {
      action.targets = candidate.targets.filter(
        (target) =>
          typeof target === 'object' &&
          target !== null &&
          typeof target.slot === 'number' &&
          typeof target.choice === 'string',
      );
    }
    if (typeof candidate.id === 'string' && candidate.id.length > 0) action.id = candidate.id;
    if (typeof candidate.source === 'object' && candidate.source !== null) {
      const source: PlannedSourceReference = {};
      if (typeof candidate.source.objectId === 'string')
        source.objectId = candidate.source.objectId;
      if (typeof candidate.source.cardId === 'string') source.cardId = candidate.source.cardId;
      if (typeof candidate.source.name === 'string') source.name = candidate.source.name;
      if (Object.keys(source).length > 0) action.source = source;
    }
    if (Array.isArray(candidate.dependencies)) {
      action.dependencies = candidate.dependencies.filter(
        (dependency): dependency is string => typeof dependency === 'string',
      );
    }
    if (Array.isArray(candidate.preconditions)) {
      action.preconditions = candidate.preconditions.filter(
        (precondition): precondition is PlanPrecondition =>
          typeof precondition === 'object' &&
          precondition !== null &&
          typeof precondition.kind === 'string' &&
          [
            'phaseReached',
            'actionCompleted',
            'sourceAvailable',
            'targetAvailable',
            'legalActionAvailable',
          ].includes(precondition.kind),
      );
    }
    if (typeof candidate.expectedEffect === 'string')
      action.expectedEffect = candidate.expectedEffect.slice(0, 500);
    if (typeof candidate.objective === 'string')
      action.objective = candidate.objective.slice(0, 500);
    if (typeof candidate.alternative === 'string')
      action.alternative = candidate.alternative.slice(0, 500);
    plannedActions.push(action);
  }

  return {
    intent: raw.intent.slice(0, 500),
    plannedActions,
    ...(Array.isArray(raw.threatOrder)
      ? {
          threatOrder: raw.threatOrder.filter((seat): seat is string => typeof seat === 'string'),
        }
      : {}),
    ...(typeof raw.manaPlan === 'string' ? { manaPlan: raw.manaPlan.slice(0, 500) } : {}),
    ...(steering !== null ? { steering } : {}),
  };
}

/**
 * Match-scoped strategy state shared by every seat provider. This is the observation point the
 * old per-provider TurnPlanManager lacked: every opponent action reaches the same plan queue.
 *
 * The strategist call is deliberately OFF the decision critical path (ADR 0016 predates this;
 * see the player-experience overhaul plan). `prepare()`/`prefetch()` start the call and return
 * immediately; `guidanceFor()` and `tryExecutePlan()` read whatever has landed so far, which is
 * `null`/no-plan until the promise settles — exactly the "no strategy yet" path the tactician
 * already handles. This is why the strategist call, at 20-60s, no longer gates a 3-4s tactical
 * decision.
 */
export class StrategyCoordinator {
  private readonly turnPlan: TurnPlanManager;
  private readonly recentBySeat = new Map<string, RecentSeatDecision[]>();
  /** Whole-game sampled decision history per seat, for the post-game review (ADR 0022 §7). */
  private readonly digestBySeat = new Map<string, RecentSeatDecision[]>();
  /** How many digest entries a `seat:turn:phase` has already contributed. */
  private readonly digestCounts = new Map<string, number>();
  private readonly publicMemory = new PublicMemoryTracker();
  private plannedTurn = -1;
  private plannedPlayer: string | null = null;
  private strategy: TurnStrategy | null = null;
  private strategyAttempted = false;
  /** The planned seat's deals when its plan's prompt was built (see `tryExecutePlan`). */
  private planDealsKey = '';
  /** One re-plan is allowed per turn after an opponent intervention invalidates the strategy. */
  private replanned = false;
  /** Generation tracking for strategist calls to reject stale/invalidated in-flight plans. */
  private strategistGeneration = 0;
  private activeGeneration = 0;
  private pendingAcceptedActions: AcceptedPlanAction[] | null = null;
  /** The in-flight (or last-settled) strategist call, for tests and turn-boundary bookkeeping. */
  private inFlight: Promise<void> | null = null;
  /** Aborts whatever strategist call is currently in flight (or queued, unstarted). */
  private abortController: AbortController | null = null;
  /**
   * Every strategist call not yet settled. A later turn can start a call before an earlier one
   * ends, so `cancel()` and `settled()` must reach all of them, not only the newest.
   */
  private readonly outstanding = new Map<Promise<void>, AbortController>();
  /** Set by `cancel()` when the match halts/is abandoned — no further strategist call starts. */
  private cancelled = false;
  /**
   * Bot-led mode (ADR 0039): each seat's latest strategist knobs, kept across turns, with the
   * public table they were set against and how many of the seat's turns have reused them.
   */
  private readonly steeringBySeat = new Map<
    PlayerId,
    { steering: BotSteering; table: TableSnapshot; reusedTurns: number }
  >();
  /**
   * Hill-climb S6: what each seat's last installed knobs were drawn from, and how many delta
   * prompts in a row it has had since its last full one.
   */
  private readonly deltaBySeat = new Map<PlayerId, { base: StrategistDeltaBase; inRow: number }>();
  /** Strategist calls made, skipped because the knobs still fit, and sent as deltas. */
  readonly strategistStats = { calls: 0, reused: 0, delta: 0 };
  /** Every shadow tactician request this game, in order (ADR 0045). */
  readonly tacticianRequests: TacticianRequestRecord[] = [];
  /**
   * Fires when a strategist plan installs, carrying its standing intent (ADR 0022). The session
   * turns this into a log annotation; nothing here depends on it being set.
   */
  onStrategy?: (turn: number, activePlayer: PlayerId, intent: string, model: string) => void;
  /**
   * Table diplomacy (ADR 0035 phase 4), set only in a game with deals. `diplomacyFor` gives a
   * seat's deal context for a role (null leaves the prompt as it was), and `onDealProposal`
   * receives a strategist's raw `dealProposal`, which the session reads and offers through the
   * table like any other proposal.
   */
  diplomacyFor?: (seat: PlayerId, role: 'strategist' | 'tactician') => SeatDiplomacyContext | null;
  onDealProposal?: (turn: number, seat: PlayerId, raw: unknown) => void;

  constructor(
    private readonly strategistClient: AiClient | null,
    private readonly queue: QueueLike,
    private readonly engine: Engine,
    private readonly config: AiConfig,
    private readonly logger?: AiCallLogger,
    /** Never plan these seats' own turns — no tactician ever consumes them (see `guidanceFor`). */
    private readonly humanSeats?: ReadonlySet<PlayerId>,
    /**
     * Each seat's own inferred archetype (ADR 0022 §5), so the strategist knows what the deck it
     * is piloting is built to do. Read only for the seat being planned — an archetype comes from
     * a full decklist, so handing one seat another's would leak hidden information (brief §7.1).
     */
    private readonly deckArchetypes?: ReadonlyMap<PlayerId, string>,
    /** Versioned own-deck profiles, keyed by seat. Never populated from an opponent lookup. */
    private readonly deckProfiles?: ReadonlyMap<PlayerId, StrategyProfile>,
  ) {
    this.turnPlan = new TurnPlanManager(config.planLifecycleScopedInvalidationEnabled);
    this.turnPlan.onInvalidated = () => {
      // Bot-led knobs are not a plan of actions, so nothing they hold can be invalidated.
      if (this.botLed()) return;
      this.strategy = null;
      if (!this.config.planLifecycleScopedInvalidationEnabled) return;
      this.activeGeneration = 0;
      if (!this.replanned) {
        this.replanned = true;
        this.strategyAttempted = false;
      }
    };
  }

  /**
   * Ahead-of-time trigger, fired once per turn boundary (the previous turn's last decision) for
   * the seat about to become active. Overlaps the strategist call with the end step, untap,
   * upkeep, and draw of the incoming turn, plus every other seat's tactical calls.
   */
  prefetch(gameId: GameId, turn: number, activePlayer: PlayerId): void {
    this.syncPublicMemory();
    this.resetIfNewTurn(turn, activePlayer);
    this.startStrategist(gameId, turn, activePlayer, 'precombatMain', null);
  }

  /** Called on every decision; starts the strategist at most once per (turn, activePlayer). */
  prepare(request: DecisionRequest): void {
    this.syncPublicMemory();
    this.resetIfNewTurn(request.turn, request.activePlayer);
    if (request.phase === 'beginning') return;
    this.startStrategist(
      request.gameId,
      request.turn,
      request.activePlayer,
      request.phase,
      request.step,
    );
  }

  /** Diagnostic/test-only: resolves once the most recently started strategist call has settled. */
  async settled(): Promise<void> {
    await this.inFlight;
  }

  /**
   * Resolves once every strategist call started so far has settled, including older calls a
   * later turn overtook. Used at game end, after `cancel()`, before costs are reported.
   */
  async drained(): Promise<void> {
    while (this.outstanding.size > 0) {
      await Promise.allSettled([...this.outstanding.keys()]);
    }
  }

  private resetIfNewTurn(turn: number, activePlayer: PlayerId): void {
    if (this.plannedTurn !== turn || this.plannedPlayer !== activePlayer) {
      this.plannedTurn = turn;
      this.plannedPlayer = activePlayer;
      this.strategy = null;
      this.activeGeneration = 0;
      this.pendingAcceptedActions = null;
      this.strategyAttempted = false;
      this.replanned = false;
      this.turnPlan.clear();
    }
  }

  private startStrategist(
    gameId: GameId,
    turn: number,
    activePlayer: PlayerId,
    phase: Phase,
    step: Step | null,
  ): void {
    if (
      !this.config.strategistEnabled ||
      this.strategistClient === null ||
      this.strategyAttempted ||
      this.cancelled ||
      turn <= 0 ||
      this.humanSeats?.has(activePlayer) === true
    ) {
      return;
    }

    this.strategyAttempted = true;
    if (this.reuseSteering(activePlayer)) return;
    const wake = this.wakeReasons(activePlayer);
    this.strategistStats.calls++;
    this.strategistGeneration++;
    const generation = this.strategistGeneration;
    this.activeGeneration = generation;
    const strategyRequest: DecisionRequest = {
      requestId: `${gameId}-t${turn}-${activePlayer}-strategy`,
      gameId,
      turn,
      activePlayer,
      decidingPlayer: activePlayer,
      phase,
      step,
      decisionType: 'general',
      prompt: 'Create the active player turn strategy.',
      legalActions: [{ id: 0, type: 'planTurn', description: 'Return the turn strategy' }],
    };
    const controller = new AbortController();
    this.abortController = controller;
    const call = this.runStrategist(strategyRequest, generation, controller.signal, wake);
    this.inFlight = call;
    this.outstanding.set(call, controller);
    const forget = (): void => {
      this.outstanding.delete(call);
    };
    call.then(forget, forget);
  }

  /**
   * Stops chasing a strategist plan the match no longer needs — a halt or an abandon. Aborts
   * whatever call is currently queued or in flight (see `RequestQueue`/`AiClient`, which honor
   * the signal all the way down to the underlying HTTP request) and blocks every future one:
   * without this, a strategist call fired ahead-of-time for a turn boundary the engine reached
   * during compute-ahead keeps running — and keeps getting billed — after the game has already
   * stopped.
   */
  cancel(): void {
    this.cancelled = true;
    this.abortController?.abort();
    for (const controller of this.outstanding.values()) controller.abort();
  }

  private async runStrategist(
    strategyRequest: DecisionRequest,
    generation: number,
    signal: AbortSignal,
    wake: string[] = [],
  ): Promise<void> {
    const activePlayer = strategyRequest.activePlayer;
    const acceptedActions: AcceptedPlanAction[] = [];
    this.pendingAcceptedActions = acceptedActions;
    const view = this.engine.view(activePlayer);
    const sourceEvents =
      typeof this.engine.eventsSince === 'function' ? this.engine.eventsSince(0) : [];
    const sourceSequence = sourceEvents.at(-1)?.sequence ?? 0;
    const generationStartedAt = new Date().toISOString();
    const recent = this.recentFor(activePlayer);
    const diplomacy = this.diplomacyFor?.(activePlayer, 'strategist') ?? null;
    const dealsKey = this.dealsKey(activePlayer);
    const deltaOn = this.botLed() && this.config.strategistDeltaEnabled;
    const deltaState = deltaOn ? this.deltaBySeat.get(activePlayer) : undefined;
    const delta =
      deltaState !== undefined && deltaState.inRow < this.config.strategistDeltaRefreshEvery
        ? { base: deltaState.base, wake }
        : undefined;
    if (delta !== undefined) this.strategistStats.delta++;
    const assembledPrompt = assembleStrategistPrompt(
      strategyRequest,
      view,
      recent,
      this.deckArchetypes?.get(activePlayer),
      {
        ...(this.deckProfiles?.get(activePlayer) === undefined
          ? {}
          : { profile: this.deckProfiles.get(activePlayer)! }),
        ...(diplomacy === null ? {} : { diplomacy }),
        ...(this.botLed() ? { botSteering: true } : {}),
        ...(this.botLed() && this.config.strategistTacticianFlag === 'shadow'
          ? { tacticianFlag: true }
          : {}),
        ...(deltaOn ? { delta: delta ?? true } : {}),
        context: {
          includeMemory: this.config.contextMemoryEnabled,
          includeFeatures: this.config.contextFeaturesEnabled,
          useBudgeter: this.config.contextBudgeterEnabled,
          useCardSummaries: this.config.contextCardSummariesEnabled,
          inputTokenBudget: this.config.contextInputTokenBudget,
          ...(this.config.contextMemoryEnabled
            ? { publicMemory: this.publicMemory.snapshot() }
            : {}),
          ...(this.config.contextFeaturesEnabled
            ? { stateFeatures: extractStateFeatures(strategyRequest, view) }
            : {}),
        },
      },
    );
    // The profile (or the legacy archetype tag standing in for one) and the task text are fixed
    // for this seat all game, so they belong in the cacheable prefix, not after the observation.
    const prompt = this.config.providerPromptCacheLayoutEnabled
      ? preparePromptForCaching(assembledPrompt, {
          role: 'strategist',
          staticKeys: ['strategyTask', 'yourStrategyProfile'],
          ...(deltaOn ? { splitCommanders: false } : {}),
        })
      : assembledPrompt;

    try {
      const result = await this.queue.enqueue(
        () => this.strategistClient!.requestDecision(prompt, strategyRequest, signal),
        signal,
      );
      const strategy = cleanPlan(result.response.turnStrategy, {
        opponents: view.opponents.filter((o) => o.life > 0).map((o) => o.seat),
        botLed: this.botLed(),
      });
      // ADR 0045 decision 5: logged, never acted on, and parsed apart from the knobs.
      const tacticianRequest = this.botLed()
        ? readTacticianRequest(result.response.turnStrategy)
        : null;
      if (tacticianRequest !== null && !this.cancelled) {
        const record: TacticianRequestRecord = {
          turn: strategyRequest.turn,
          seat: activePlayer,
          reason: tacticianRequest.reason,
          wake,
          knobs: strategy?.steering !== undefined,
        };
        this.tacticianRequests.push(record);
        this.engine.addDebug(
          'decision',
          `strategist asked for the tactician for ${activePlayer} (shadow)`,
          {
            turn: record.turn,
            reason: record.reason,
            wake: record.wake,
            knobs: record.knobs,
          },
        );
      }
      if (result.response.actionId !== 0 || strategy === null) {
        this.engine.addDebug('decision', `strategist returned no usable plan for ${activePlayer}`);
        return;
      }
      // Knobs outlive the turn they were asked for, unlike a planned action list. In bot mode a
      // seat's turn usually ends before the strategist answers, so install them even when the
      // staleness check below drops the plan; otherwise every answer is paid for and thrown away.
      if (this.botLed() && strategy.steering !== undefined && !this.cancelled) {
        this.steeringBySeat.set(activePlayer, {
          steering: strategy.steering,
          table: tableSnapshot(view),
          reusedTurns: 0,
        });
        if (deltaOn) {
          this.deltaBySeat.set(activePlayer, {
            base: deltaBaseFrom(view, strategyRequest.turn, strategy.intent, strategy.steering),
            inRow: delta === undefined ? 0 : (deltaState?.inRow ?? 0) + 1,
          });
        }
      }
      // A turn/player change (or a fresh re-plan) may have superseded this call while it was
      // in flight; don't install a stale plan over what the board now needs.
      if (
        this.activeGeneration !== generation ||
        this.plannedTurn !== strategyRequest.turn ||
        this.plannedPlayer !== activePlayer
      ) {
        return;
      }
      this.strategy = strategy;
      this.planDealsKey = dealsKey;
      const metadata: PlanArtifactMetadata = {
        planId: `${strategyRequest.requestId}:g${generation}`,
        generationId: generation,
        observerSeat: activePlayer,
        source: {
          eventSequence: sourceSequence,
          hash: observationHash({ request: strategyRequest, view }),
          turn: strategyRequest.turn,
          phase: strategyRequest.phase,
          step: strategyRequest.step,
        },
        promptVersion: AI_VERSIONS.prompt,
        configVersion: AI_VERSIONS.policy,
        generationStartedAt,
        generationCompletedAt: new Date().toISOString(),
        installationSequence:
          typeof this.engine.eventsSince === 'function'
            ? (this.engine.eventsSince(0).at(-1)?.sequence ?? 0)
            : 0,
      };
      this.turnPlan.recordPlan(strategyRequest, strategy.plannedActions, this.engine, {
        metadata,
        sourceView: view,
        acceptedSinceSource: acceptedActions,
      });
      this.logger?.log(strategyRequest, result, false, false, 'strategist');
      this.onStrategy?.(strategyRequest.turn, activePlayer, strategy.intent, result.meta.model);
      const proposal = (result.response.turnStrategy as { dealProposal?: unknown } | undefined)
        ?.dealProposal;
      if (proposal !== undefined && diplomacy !== null) {
        this.onDealProposal?.(strategyRequest.turn, activePlayer, proposal);
      }
      this.engine.addDebug(
        'decision',
        `strategist call completed for ${activePlayer} [model: ${result.meta.model}, latency: ${result.meta.latencyMs}ms, tokens: ${result.meta.promptTokens}+${result.meta.responseTokens}]`,
        {
          requestId: strategyRequest.requestId,
          model: result.meta.model,
          latencyMs: result.meta.latencyMs,
          tokens: { prompt: result.meta.promptTokens, response: result.meta.responseTokens },
        },
      );
    } catch (error) {
      // A deliberate `cancel()` (halt/abandon), not a call gone wrong — nothing to warn about.
      if (error instanceof RequestCancelledError) return;
      this.engine.addDebug(
        'decision',
        `strategist call failed for ${activePlayer}: ${(error as Error).message}`,
      );
    } finally {
      if (this.pendingAcceptedActions === acceptedActions) this.pendingAcceptedActions = null;
    }
  }

  /** The strategist's current knobs for a seat in bot-led mode, if it has set any (ADR 0039). */
  steeringFor(seat: PlayerId): BotSteering | undefined {
    return this.steeringBySeat.get(seat)?.steering;
  }

  private botLed(): boolean {
    return this.config.tacticalMode === 'bot';
  }

  /**
   * Why `onChange` would call the strategist for `seat` now: it has no knobs yet, its knobs hit
   * the reuse limit, or the table moved. Empty means `onChange` would have reused the knobs.
   *
   * Under `everyTurn` every turn is a call, so the knobs' table snapshot and reuse count never age
   * the way `onChange` would age them. The answer then comes from a simulated `onChange`: the table
   * when it would last have called, and how many turns it would have reused since (ADR 0045).
   */
  private wakeReasons(seat: PlayerId): string[] {
    const now = tableSnapshot(this.engine.view(seat));
    const max = this.config.strategistMaxReuseTurns;
    if (this.config.strategistReplan === 'onChange') {
      const current = this.steeringBySeat.get(seat);
      if (current === undefined) return ['first knobs'];
      if (current.reusedTurns >= max) return ['reuse limit'];
      return tableChangeReasons(current.table, now);
    }
    const simulated = this.simulatedOnChange.get(seat);
    let reasons: string[];
    if (simulated === undefined) reasons = ['first knobs'];
    else if (simulated.reused >= max) reasons = ['reuse limit'];
    else reasons = tableChangeReasons(simulated.table, now);
    this.simulatedOnChange.set(
      seat,
      reasons.length === 0 && simulated !== undefined
        ? { table: simulated.table, reused: simulated.reused + 1 }
        : { table: now, reused: 0 },
    );
    return reasons;
  }

  /** `onChange`'s state as it would have been, for `wakeReasons` under `everyTurn`. */
  private readonly simulatedOnChange = new Map<
    PlayerId,
    { table: TableSnapshot; reused: number }
  >();

  /**
   * `strategistReplan: 'onChange'`: skip this turn's strategist call when the seat already has
   * knobs, the public table has not moved much since they were set, and they have been
   * reused fewer than `strategistMaxReuseTurns` turns.
   */
  private reuseSteering(seat: PlayerId): boolean {
    if (!this.botLed() || this.config.strategistReplan !== 'onChange') return false;
    const current = this.steeringBySeat.get(seat);
    if (current === undefined) return false;
    if (current.reusedTurns >= this.config.strategistMaxReuseTurns) return false;
    if (tableChanged(current.table, tableSnapshot(this.engine.view(seat)))) return false;
    current.reusedTurns++;
    this.strategistStats.reused++;
    this.engine.addDebug?.('decision', `strategist knobs reused for ${seat}`, {
      reusedTurns: current.reusedTurns,
    });
    return true;
  }

  guidanceFor(
    playerId: string,
    request?: DecisionRequest,
    view?: ReturnType<Engine['view']>,
  ): TacticalGuidance {
    this.syncPublicMemory();
    return {
      strategy: playerId === this.plannedPlayer ? this.strategy : null,
      recentDecisions: this.recentFor(playerId),
      ...this.dealsGuidance(playerId),
      ...(this.config.contextMemoryEnabled ? { publicMemory: this.publicMemory.snapshot() } : {}),
      ...(this.config.contextFeaturesEnabled && request !== undefined && view !== undefined
        ? { stateFeatures: extractStateFeatures(request, view) }
        : {}),
    };
  }

  private dealsGuidance(seat: PlayerId): { deals?: SeatDiplomacyContext } {
    const deals = this.diplomacyFor?.(seat, 'tactician') ?? null;
    return deals === null ? {} : { deals };
  }

  tryExecutePlan(request: DecisionRequest): DecisionResponse | null {
    // A plan made before the seat's deals changed never weighed them (ADR 0035): a queued step
    // could break a promise made since. Let the tactician, which sees the deals, decide instead.
    if (
      request.decidingPlayer === this.plannedPlayer &&
      this.dealsKey(request.decidingPlayer) !== this.planDealsKey
    ) {
      return null;
    }
    return this.turnPlan.tryExecutePlan(request, this.engine);
  }

  /** The seat's own deals as its tactician sees them, as a comparable key; '' without deals. */
  private dealsKey(seat: PlayerId): string {
    const deals = this.diplomacyFor?.(seat, 'tactician') ?? null;
    return deals === null ? '' : JSON.stringify(deals);
  }

  recordAcceptedDecision(request: DecisionRequest, response: DecisionResponse): void {
    this.turnPlan.recordAccepted(request, response, this.engine);
    // An action taken while the strategist is thinking does not cancel or invalidate the
    // response. Its intent remains useful; TurnPlanManager checks the current phase and legal
    // action menu before executing any planned step.
    const action = request.legalActions.find((action) => action.id === response.actionId);
    if (
      this.pendingAcceptedActions !== null &&
      request.turn === this.plannedTurn &&
      request.decidingPlayer === this.plannedPlayer &&
      action !== undefined
    ) {
      this.pendingAcceptedActions.push({
        turn: request.turn,
        player: request.decidingPlayer,
        phase: request.phase,
        step: request.step,
        action,
        ...(response.targets === undefined ? {} : { targets: response.targets }),
      });
    }
  }

  planLifecycle() {
    return this.turnPlan.getLifecycleEvents();
  }

  recordDecision(
    request: DecisionRequest,
    response: DecisionResponse,
    source: DecisionSource,
  ): void {
    const chosen = request.legalActions.find((action) => action.id === response.actionId);
    if (chosen !== undefined) {
      this.recordDigest(request, chosen.type, chosen.description);
      const recent = this.recentBySeat.get(request.decidingPlayer) ?? [];
      recent.push({ turn: request.turn, phase: request.phase, action: chosen.description });
      const limit = this.config.strategyRecentDecisionLimit;
      if (recent.length > limit) recent.splice(0, recent.length - limit);
      this.recentBySeat.set(request.decidingPlayer, recent);

      if (
        !this.config.planLifecycleScopedInvalidationEnabled &&
        request.decidingPlayer !== request.activePlayer &&
        request.turn === this.plannedTurn &&
        !['pass', 'passAndYieldTurn', 'yieldToAbility'].includes(chosen.type)
      ) {
        this.strategy = null;
        this.activeGeneration = 0;
        if (!this.replanned) {
          this.replanned = true;
          this.strategyAttempted = false;
          this.startStrategist(
            request.gameId,
            request.turn,
            request.activePlayer,
            request.phase,
            request.step,
          );
        }
      }
    }

    // Tactical calls cannot replace the once-per-turn strategy with ad-hoc plannedActions.
    let withoutTacticalPlan = response;
    if (source !== 'strategist') {
      const { plannedActions: _ignored, ...rest } = response;
      withoutTacticalPlan = rest;
    }
    this.turnPlan.recordDecision(request, withoutTacticalPlan, source, this.engine);
  }

  private recentFor(playerId: string): readonly RecentSeatDecision[] {
    return this.recentBySeat.get(playerId) ?? [];
  }

  private syncPublicMemory(): void {
    if (typeof this.engine.eventsSince !== 'function') return;
    const nextSequence = this.publicMemory.snapshot().throughEventSequence + 1;
    this.publicMemory.observe(this.engine.eventsSince(nextSequence));
  }

  /**
   * Sample one decision into the seat's whole-game digest: the first real action of each main
   * phase, and up to three combat decisions per turn. Passes are dropped. A full game runs to
   * thousands of decisions, most of them "pass"; the sampling is what makes the arc of a game fit
   * in a prompt at all.
   */
  private recordDigest(request: DecisionRequest, type: string, description: string): void {
    if (DIGEST_SKIP_TYPES.has(type)) return;
    const key = `${request.decidingPlayer}:${request.turn}:${request.phase}`;
    const limit = request.phase === 'combat' ? DIGEST_COMBAT_PER_TURN : 1;
    const seen = this.digestCounts.get(key) ?? 0;
    if (seen >= limit) return;
    this.digestCounts.set(key, seen + 1);

    const digest = this.digestBySeat.get(request.decidingPlayer) ?? [];
    digest.push({ turn: request.turn, phase: request.phase, action: description });
    this.digestBySeat.set(request.decidingPlayer, thinDigest(digest));
  }

  /** The seat's sampled decision history for the whole game, oldest first (ADR 0022 §7). */
  digestFor(playerId: string): readonly RecentSeatDecision[] {
    return this.digestBySeat.get(playerId) ?? [];
  }
}
