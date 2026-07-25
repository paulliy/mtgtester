/**
 * Validation logic for AI responses (§7.3, §7.7).
 * Pre-validates the AI's returned decision against the offered legal action menu
 * before submitting to the engine state machine.
 */

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
