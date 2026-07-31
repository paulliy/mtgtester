import type { Engine } from '@mtg/engine';
import type {
  DecisionRequest,
  DecisionResponse,
  GameId,
  PlayerId,
  Phase,
  PlannedAction,
  Step,
  TurnStrategy,
} from '@mtg/shared';
import type { AiClient } from './client';
import type { AiConfig } from './config';
import {
  assembleStrategistPrompt,
  type RecentSeatDecision,
  type TacticalGuidance,
} from './context';
import type { AiCallLogger, DecisionSource } from './logger';
import { TurnPlanManager } from './turn-plan';

interface QueueLike {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
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

function cleanPlan(raw: TurnStrategy | undefined): TurnStrategy | null {
  if (raw === undefined || typeof raw.intent !== 'string' || !Array.isArray(raw.plannedActions)) {
    return null;
  }

  const plannedActions: PlannedAction[] = [];
  for (const candidate of raw.plannedActions.slice(0, 16)) {
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
  private readonly turnPlan = new TurnPlanManager();
  private readonly recentBySeat = new Map<string, RecentSeatDecision[]>();
  private plannedTurn = -1;
  private plannedPlayer: string | null = null;
  private strategy: TurnStrategy | null = null;
  private strategyAttempted = false;
  /** One re-plan is allowed per turn after an opponent intervention invalidates the strategy. */
  private replanned = false;
  /** The in-flight (or last-settled) strategist call, for tests and turn-boundary bookkeeping. */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly strategistClient: AiClient | null,
    private readonly queue: QueueLike,
    private readonly engine: Engine,
    private readonly config: AiConfig,
    private readonly logger?: AiCallLogger,
    /** Never plan this seat's own turn — no tactician ever consumes it (see `guidanceFor`). */
    private readonly humanSeat?: PlayerId | null,
  ) {}

  /**
   * Ahead-of-time trigger, fired once per turn boundary (the previous turn's last decision) for
   * the seat about to become active. Overlaps the strategist call with the end step, untap,
   * upkeep, and draw of the incoming turn, plus every other seat's tactical calls.
   */
  prefetch(gameId: GameId, turn: number, activePlayer: PlayerId): void {
    this.resetIfNewTurn(turn, activePlayer);
    this.startStrategist(gameId, turn, activePlayer, 'precombatMain', null);
  }

  /** Called on every decision; starts the strategist at most once per (turn, activePlayer). */
  prepare(request: DecisionRequest): void {
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

  private resetIfNewTurn(turn: number, activePlayer: PlayerId): void {
    if (this.plannedTurn !== turn || this.plannedPlayer !== activePlayer) {
      this.plannedTurn = turn;
      this.plannedPlayer = activePlayer;
      this.strategy = null;
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
      turn <= 0 ||
      activePlayer === this.humanSeat
    ) {
      return;
    }

    this.strategyAttempted = true;
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
    this.inFlight = this.runStrategist(strategyRequest);
  }

  private async runStrategist(strategyRequest: DecisionRequest): Promise<void> {
    const activePlayer = strategyRequest.activePlayer;
    const view = this.engine.view(activePlayer);
    const recent = this.recentFor(activePlayer);
    const prompt = assembleStrategistPrompt(strategyRequest, view, recent);

    try {
      const result = await this.queue.enqueue(() =>
        this.strategistClient!.requestDecision(prompt, strategyRequest),
      );
      const strategy = cleanPlan(result.response.turnStrategy);
      if (result.response.actionId !== 0 || strategy === null) {
        this.engine.addDebug('decision', `strategist returned no usable plan for ${activePlayer}`);
        return;
      }
      // A turn/player change (or a fresh re-plan) may have superseded this call while it was
      // in flight; don't install a stale plan over what the board now needs.
      if (
        this.plannedTurn !== strategyRequest.turn ||
        this.plannedPlayer !== activePlayer
      ) {
        return;
      }
      this.strategy = strategy;
      this.turnPlan.recordPlan(strategyRequest, strategy.plannedActions, this.engine);
      this.logger?.log(strategyRequest, result, false, false, 'strategist');
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
      this.engine.addDebug(
        'decision',
        `strategist call failed for ${activePlayer}: ${(error as Error).message}`,
      );
    }
  }

  guidanceFor(playerId: string): TacticalGuidance {
    return {
      strategy: playerId === this.plannedPlayer ? this.strategy : null,
      recentDecisions: this.recentFor(playerId),
    };
  }

  tryExecutePlan(request: DecisionRequest): DecisionResponse | null {
    return this.turnPlan.tryExecutePlan(request, this.engine);
  }

  recordDecision(
    request: DecisionRequest,
    response: DecisionResponse,
    source: DecisionSource,
  ): void {
    const chosen = request.legalActions.find((action) => action.id === response.actionId);
    if (chosen !== undefined) {
      const recent = this.recentBySeat.get(request.decidingPlayer) ?? [];
      recent.push({ turn: request.turn, phase: request.phase, action: chosen.description });
      const limit = this.config.strategyRecentDecisionLimit;
      if (recent.length > limit) recent.splice(0, recent.length - limit);
      this.recentBySeat.set(request.decidingPlayer, recent);

      if (
        request.decidingPlayer !== request.activePlayer &&
        request.turn === this.plannedTurn &&
        !['pass', 'passAndYieldTurn', 'yieldToAbility'].includes(chosen.type)
      ) {
        this.strategy = null;
        // Off the critical path, a re-plan is affordable — but only once per turn, so a
        // contested board can't turn into a strategist call on every single intervention.
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
}
