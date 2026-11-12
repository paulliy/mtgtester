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

  return validateDamageSplit(response, request);
}

/**
 * A combat-damage division is answered by its `combatDamageSplit`, not by the option the
 * `actionId` names. The engine never refuses one: a split it cannot use is replaced by all the
 * damage on the first blocker, which silently turns a lethal trample attack into no damage to the
 * player. Checking it here sends the model a corrective retry instead (§7.7 step 1).
 */
function validateDamageSplit(response: DecisionResponse, request: DecisionRequest): string | null {
  const offered = request.combatDamageSplit;
  if (offered === undefined) return null;
  const { amount, targets, lethal } = offered;
  const example = `{${targets.map((id) => `"${id}": <whole number>`).join(', ')}}`;
  const split = response.combatDamageSplit;
  if (split === undefined)
    return `this decision is answered with "combatDamageSplit", not by actionId alone: divide ${amount} damage as ${example}`;
  for (const [id, value] of Object.entries(split)) {
    if (!targets.includes(id))
      return `combatDamageSplit names "${id}", which is not one of the targets: [${targets.join(', ')}]`;
    if (!Number.isInteger(value) || value < 0)
      return `combatDamageSplit["${id}"] must be a whole number of 0 or more`;
  }
  const total = targets.reduce((sum, id) => sum + (split[id] ?? 0), 0);
  if (total !== amount)
    return `combatDamageSplit sums to ${total} but must sum to exactly ${amount}`;
  if (lethal === undefined) return null;
  // Trample (CR 702.19b): the last target is the defending player or planeswalker, and it may
  // take damage only once every blocker has been assigned lethal.
  const recipients = targets.filter((id) => !(id in lethal));
  const beyond = recipients.reduce((sum, id) => sum + (split[id] ?? 0), 0);
  if (beyond === 0) return null;
  const short = targets.filter((id) => id in lethal && (split[id] ?? 0) < (lethal[id] ?? 0));
  if (short.length === 0) return null;
  const need = short.map((id) => `"${id}" needs at least ${lethal[id]}`).join(', ');
  const most = amount - targets.reduce((sum, id) => sum + (lethal[id] ?? 0), 0);
  return `combatDamageSplit gives ${beyond} to ${recipients.map((id) => `"${id}"`).join(', ')} before every blocker has lethal damage (${need}); assign each blocker its lethal amount first, which leaves at most ${Math.max(0, most)} for ${recipients.map((id) => `"${id}"`).join(', ')}`;
}
