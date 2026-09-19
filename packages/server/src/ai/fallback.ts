/**
 * Safest Legal Action Fallback Logic (§7.7 step 3).
 * Prioritizes conservative, non-irreversible actions when AI retries fail:
 * pass priority -> decline optional trigger -> do not attack -> do not block -> non-harmful action.
 */

import type { DecisionRequest, DecisionResponse, TargetChoice } from '@mtg/shared';

function firstTargets(request: DecisionRequest, actionId: number): TargetChoice[] {
  const action = request.legalActions.find((a) => a.id === actionId);
  return (action?.targets ?? []).map((slot) => ({
    slot: slot.slot,
    choice: slot.options[0] ?? '',
  }));
}

/**
 * Returns the safest conservative legal action from the request's offered menu.
 */
export function safestFallback(request: DecisionRequest): DecisionResponse {
  const actions = request.legalActions;
  if (actions.length === 0) {
    throw new Error(`Cannot select fallback: request ${request.requestId} has no legal actions`);
  }

  // 1. Pass priority
  const passAction = actions.find(
    (a) => a.type === 'pass' || a.description.toLowerCase().includes('pass'),
  );
  if (passAction !== undefined) {
    return {
      requestId: request.requestId,
      actionId: passAction.id,
      note: 'Fallback: passing priority',
    };
  }

  // 2. Decline optional triggers / choices
  const declineAction = actions.find((a) => {
    const desc = a.description.toLowerCase();
    return desc.includes('decline') || desc.includes("don't") || desc.includes('no');
  });
  if (declineAction !== undefined) {
    return {
      requestId: request.requestId,
      actionId: declineAction.id,
      targets: firstTargets(request, declineAction.id),
      note: 'Fallback: declining optional effect',
    };
  }

  // 3. Do not attack / do not block
  const noCombatAction = actions.find((a) => {
    const desc = a.description.toLowerCase();
    return (
      desc.includes('no attackers') || desc.includes('no blockers') || desc.includes("don't attack")
    );
  });
  if (noCombatAction !== undefined) {
    return {
      requestId: request.requestId,
      actionId: noCombatAction.id,
      targets: firstTargets(request, noCombatAction.id),
      note: 'Fallback: declining combat action',
    };
  }

  // 4. Exclude self-harming actions (sacrifice, discard, mill, exile own)
  const nonHarmfulAction = actions.find((a) => {
    const desc = a.description.toLowerCase();
    return (
      !desc.includes('sacrifice') &&
      !desc.includes('discard') &&
      !desc.includes('mill') &&
      !desc.includes('destroy')
    );
  });

  const chosenAction = nonHarmfulAction ?? actions[0]!;
  return {
    requestId: request.requestId,
    actionId: chosenAction.id,
    targets: firstTargets(request, chosenAction.id),
    note: `Fallback: chose conservative action "${chosenAction.description}"`,
  };
}
