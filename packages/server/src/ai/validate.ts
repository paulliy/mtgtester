/**
 * Validation logic for AI responses (§7.3, §7.7).
 * Pre-validates the AI's returned decision against the offered legal action menu
 * before submitting to the engine state machine.
 */

import { PHASES, STEPS } from '@mtg/shared';
import type { DecisionRequest, DecisionResponse } from '@mtg/shared';

/**
 * Validate a decision response against the legal menu offered in the request.
 * Returns `null` if valid, or a descriptive error message if invalid.
 */
export function validateResponse(
  response: DecisionResponse,
  request: DecisionRequest,
): string | null {
  if (response.requestId !== request.requestId) {
    return `requestId mismatch: expected "${request.requestId}", got "${response.requestId}"`;
  }

  const action = request.legalActions.find((a) => a.id === response.actionId);
  if (action === undefined) {
    return `actionId ${response.actionId} is not on the legal menu (valid IDs: 0–${request.legalActions.length - 1})`;
  }

  if (response.plannedActions !== undefined) {
    if (!Array.isArray(response.plannedActions)) return 'plannedActions must be an array';
    for (const [index, planned] of response.plannedActions.entries()) {
      if (typeof planned !== 'object' || planned === null) {
        return `plannedActions[${index}] must be an object`;
      }
      if (typeof planned.type !== 'string' || planned.type.length === 0) {
        return `plannedActions[${index}].type must be a non-empty string`;
      }
      if (planned.name !== undefined && typeof planned.name !== 'string') {
        return `plannedActions[${index}].name must be a string`;
      }
      if (planned.description !== undefined && typeof planned.description !== 'string') {
        return `plannedActions[${index}].description must be a string`;
      }
      if (planned.phase !== undefined && !PHASES.includes(planned.phase)) {
        return `plannedActions[${index}].phase is invalid`;
      }
      if (planned.step !== undefined && planned.step !== null && !STEPS.includes(planned.step)) {
        return `plannedActions[${index}].step is invalid`;
      }
      if (planned.targets !== undefined) {
        if (!Array.isArray(planned.targets)) {
          return `plannedActions[${index}].targets must be an array`;
        }
        for (const target of planned.targets) {
          if (
            typeof target !== 'object' ||
            target === null ||
            typeof target.slot !== 'number' ||
            !Number.isInteger(target.slot) ||
            typeof target.choice !== 'string'
          ) {
            return `plannedActions[${index}] has an invalid target`;
          }
        }
      }
    }
  }

  // Validate required target slots
  for (const slot of action.targets ?? []) {
    const userChoice = (response.targets ?? []).find((t) => t.slot === slot.slot)?.choice;
    if (userChoice === undefined) {
      // Single legal option in slot auto-resolves if omitted
      if (slot.options.length === 1) {
        continue;
      }
      return `missing target choice for slot ${slot.slot} (options: ${slot.options.join(', ')})`;
    }

    if (!slot.options.includes(userChoice)) {
      return `target choice "${userChoice}" for slot ${slot.slot} is not in legal options: [${slot.options.join(', ')}]`;
    }
  }

  return null;
}
