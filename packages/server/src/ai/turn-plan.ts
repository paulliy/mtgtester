/**
 * Turn Plan Manager (§7.3).
 * Enables active players to pre-plan action sequences on their turn.
 * Queued actions execute locally as long as opponents pass (via heuristic, yield, or auto-pass).
 * If an opponent takes a non-pass action or a planned action is no longer legal, the plan is invalidated.
 */

import type { DecisionRequest, DecisionResponse, LegalAction, PlannedAction } from '@mtg/shared';
import type { DecisionSource } from './logger';

import type { Engine } from '@mtg/engine';

export class TurnPlanManager {
  private activePlayer: string | null = null;
  private turnNumber = -1;
  private queue: PlannedAction[] = [];
  private opponentIntervened = false;

  /** Get current queue of planned actions for inspection. */
  getQueue(): readonly PlannedAction[] {
    return this.queue;
  }

  /** Check if a queued plan action can answer the current decision request locally. */
  tryExecutePlan(request: DecisionRequest, engine?: Engine): DecisionResponse | null {
    // Only the active player on their own turn can execute turn plans
    if (request.decidingPlayer !== request.activePlayer) return null;
    if (this.opponentIntervened) return null;
    if (this.turnNumber !== request.turn || this.activePlayer !== request.activePlayer) return null;
    if (this.queue.length === 0) return null;

    const planned = this.queue[0];
    if (planned === undefined) return null;

    const matchedAction = this.findMatchingAction(planned, request.legalActions);
    if (matchedAction === null) {
      // Planned action is no longer legal or available — invalidate the rest of the plan
      engine?.addDebug(
        'decision',
        `turn plan for ${request.decidingPlayer} invalidated: planned action (${planned.type}${planned.name ? `: ${planned.name}` : ''}) not in legal options`,
        { planned, legalActions: request.legalActions.map((a) => a.description) },
      );
      this.clear();
      return null;
    }

    // Successfully matched: consume from queue
    this.queue.shift();

    const response: DecisionResponse = {
      requestId: request.requestId,
      actionId: matchedAction.id,
      note: `TurnPlan: pre-planned action executed (${planned.type}${planned.name ? `: ${planned.name}` : ''})`,
    };
    if (planned.targets !== undefined) {
      response.targets = planned.targets;
    }

    engine?.addDebug(
      'decision',
      `decision executed from turn plan for ${request.decidingPlayer}: ${response.note}`,
      { source: 'plan', plannedAction: planned, actionId: matchedAction.id },
    );

    return response;
  }

  /** Update plan state and store any new planned actions returned in a decision. */
  recordDecision(
    request: DecisionRequest,
    response: DecisionResponse,
    source: DecisionSource,
    engine?: Engine,
  ): void {
    // Track turn changes
    if (this.turnNumber !== request.turn || this.activePlayer !== request.activePlayer) {
      this.activePlayer = request.activePlayer;
      this.turnNumber = request.turn;
      this.queue = [];
      this.opponentIntervened = false;
    }

    // Opponent intervention check: if an opponent makes a real non-heuristic/non-pass action
    if (request.decidingPlayer !== request.activePlayer) {
      const chosenAction = request.legalActions.find((a) => a.id === response.actionId);
      if (
        chosenAction !== undefined &&
        chosenAction.type !== 'pass' &&
        chosenAction.type !== 'passAndYieldTurn' &&
        chosenAction.type !== 'yieldToAbility' &&
        source !== 'heuristic' &&
        source !== 'cache'
      ) {
        if (this.queue.length > 0) {
          engine?.addDebug(
            'decision',
            `turn plan for ${this.activePlayer} invalidated: opponent ${request.decidingPlayer} took non-pass action (${chosenAction.description})`,
            { interveningPlayer: request.decidingPlayer, action: chosenAction.description },
          );
        }
        this.opponentIntervened = true;
        this.queue = [];
      }
    }

    // Store new planned actions returned by the active player
    if (
      request.decidingPlayer === request.activePlayer &&
      response.plannedActions !== undefined &&
      response.plannedActions.length > 0
    ) {
      this.queue = [...response.plannedActions];
      this.opponentIntervened = false;
      const summary = response.plannedActions
        .map((p) => `${p.type}${p.name ? `: ${p.name}` : ''}`)
        .join(', ');
      engine?.addDebug(
        'decision',
        `turn plan recorded for ${request.decidingPlayer}: [${summary}]`,
        { plannedActions: response.plannedActions },
      );
    }
  }

  /** Invalidate and clear all active turn plans. */
  clear(): void {
    this.queue = [];
    this.opponentIntervened = false;
  }

  private findMatchingAction(
    planned: PlannedAction,
    legalActions: LegalAction[],
  ): LegalAction | null {
    const isTargetValid = (action: LegalAction): boolean => {
      if (action.targets === undefined || action.targets.length === 0) return true;
      for (const slot of action.targets) {
        if (slot.options.length <= 1) continue;
        const choiceObj = planned.targets?.find((t) => t.slot === slot.slot);
        if (choiceObj === undefined || !slot.options.includes(choiceObj.choice)) return false;
      }
      return true;
    };

    if (planned.type === 'pass') {
      const pass = legalActions.find(
        (a) => a.type === 'pass' || a.type === 'passAndYieldTurn' || a.type === 'yieldToAbility',
      );
      return pass ?? null;
    }

    // Match by exact action type and name (or description inclusion)
    for (const action of legalActions) {
      if (action.type !== planned.type) continue;
      if (planned.name !== undefined && planned.name.length > 0) {
        if (!action.description.toLowerCase().includes(planned.name.toLowerCase())) continue;
      }
      if (isTargetValid(action)) return action;
    }

    // Fallback: match by description if specified
    if (planned.description !== undefined && planned.description.length > 0) {
      const descMatch = legalActions.find((a) =>
        a.description.toLowerCase().includes(planned.description!.toLowerCase()),
      );
      if (descMatch !== undefined && isTargetValid(descMatch)) return descMatch;
    }

    return null;
  }
}
