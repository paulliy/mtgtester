/**
 * Reading the server's presentation for an action (ADR 0032). Every label, cost chip and note
 * arrives on `DecisionRequest.presentation`; this module only looks them up and joins the parts
 * for display. It never reads `LegalAction.data` and never parses `description`.
 *
 * An entry the server did not send (a request from before the fields existed) shows the engine's
 * own `description` as the button text and no cost chips: the facts are unavailable, not guessed.
 */
import type { ActionPresentation, DecisionRequest, LegalAction } from '@mtg/shared';

/** The presentation entry the server sent for `action`, if any. */
export function entryFor(
  request: Pick<DecisionRequest, 'presentation'> | null,
  action: LegalAction,
): ActionPresentation | undefined {
  return request?.presentation?.actions?.[action.id];
}

/** The text on an action's button: its label, then how a land enters and why a cost differs. */
export function buttonLabel(action: LegalAction, entry: ActionPresentation | undefined): string {
  if (entry?.label === undefined) return action.description;
  const note = entry.entryNote === undefined ? '' : ` (${entry.entryNote})`;
  const hint = entry.targetHint === undefined ? '' : ` — ${entry.targetHint}`;
  return `${entry.label}${note}${hint}`;
}

/** The "what you are about to do" heading for a selected action. */
export function pendingLabel(action: LegalAction, entry: ActionPresentation | undefined): string {
  return entry?.summary ?? action.description;
}

/** The cost chips of an action, mana cost first. */
export function costChips(entry: ActionPresentation | undefined): readonly string[] {
  return entry?.costLabels ?? [];
}

/** The decision's prompt in player terms; the engine's own text when the server sent none. */
export function promptOf(request: DecisionRequest): string {
  return request.presentation?.playerPrompt ?? request.prompt;
}

/**
 * The text on a button in the generic decision panel. A choice decision's entry names the option
 * ("Discard", "Keep on top"). A priority menu's entry names only a kind of action ("Cast"), shared
 * by every option of that kind, so the engine's own description is what tells the options apart:
 * the panel shows it unchanged.
 */
export function panelButtonText(request: DecisionRequest, action: LegalAction): string {
  if (request.presentation?.layout === 'priority') return action.description;
  return entryFor(request, action)?.verb ?? action.description;
}
