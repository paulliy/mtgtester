import type { Engine } from '@mtg/engine';
import type {
  DecisionRequest,
  DecisionResponse,
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
 */
export class StrategyCoordinator {
  private readonly turnPlan = new TurnPlanManager();
  private readonly recentBySeat = new Map<string, RecentSeatDecision[]>();
  private plannedTurn = -1;
  private plannedPlayer: string | null = null;
  private strategy: TurnStrategy | null = null;
  private strategyAttempted = false;

  constructor(
    private readonly strategistClient: AiClient | null,
    private readonly queue: QueueLike,
    private readonly engine: Engine,
    private readonly config: AiConfig,
    private readonly logger?: AiCallLogger,
  ) {}

  async prepare(request: DecisionRequest): Promise<void> {
    if (this.plannedTurn !== request.turn || this.plannedPlayer !== request.activePlayer) {
      this.plannedTurn = request.turn;
      this.plannedPlayer = request.activePlayer;
      this.strategy = null;
      this.strategyAttempted = false;
      this.turnPlan.clear();
    }

    if (
      !this.config.strategistEnabled ||
      this.strategistClient === null ||
      this.strategyAttempted ||
      request.turn <= 0 ||
      request.phase === 'beginning'
    ) {
      return;
    }

    this.strategyAttempted = true;
    const strategyRequest: DecisionRequest = {
      ...request,
      requestId: `${request.gameId}-t${request.turn}-${request.activePlayer}-strategy`,
      decidingPlayer: request.activePlayer,
      decisionType: 'general',
      prompt: 'Create the active player turn strategy.',
      legalActions: [{ id: 0, type: 'planTurn', description: 'Return the turn strategy' }],
    };
    const view = this.engine.view(request.activePlayer);
    const recent = this.recentFor(request.activePlayer);
    const prompt = assembleStrategistPrompt(strategyRequest, view, recent);

    try {
      const result = await this.queue.enqueue(() =>
        this.strategistClient!.requestDecision(prompt, strategyRequest),
      );
      const strategy = cleanPlan(result.response.turnStrategy);
      if (result.response.actionId !== 0 || strategy === null) {
        this.engine.addDebug(
          'decision',
          `strategist returned no usable plan for ${request.activePlayer}`,
        );
        return;
      }
      this.strategy = strategy;
      this.turnPlan.recordPlan(strategyRequest, strategy.plannedActions, this.engine);
      this.logger?.log(strategyRequest, result, false, false, 'strategist');
    } catch (error) {
      this.engine.addDebug(
        'decision',
        `strategist call failed for ${request.activePlayer}: ${(error as Error).message}`,
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
        !['pass', 'passAndYieldTurn', 'yieldToAbility'].includes(chosen.type)
      ) {
        this.strategy = null;
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
