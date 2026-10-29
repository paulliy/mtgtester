/**
 * Server-computed presentation (ADR 0032 decision 3). The browser renders what this module
 * writes; it parses no engine text, reads no `LegalAction.data`, and holds no rules constants.
 *
 * `enrichPresentation` takes the request a seat is about to be sent, after smart-yield
 * filtering, and the seat's own board projection. It reads nothing else, never `GameState`, so
 * an entry can only name what that seat is allowed to see.
 */

import { PHASES, STEPS, turnPositionLabel } from '@mtg/shared';
import type {
  ActionPresentation,
  DecisionPresentation,
  DecisionRequest,
  GameEvent,
  GameResult,
  LegalAction,
  Phase,
  PlayerBoardState,
  Step,
} from '@mtg/shared';
import {
  actionCost,
  actionLabelParts,
  manaSymbols,
  paymentSourceIds,
  paymentSourceSummary,
  pendingSummary,
  xFamily,
} from '@mtg/shared/presentation';
import { lossReasonLabel } from './loss-reasons';

const isPhase = (value: string): value is Phase => (PHASES as readonly string[]).includes(value);
const isStep = (value: string): value is Step => (STEPS as readonly string[]).includes(value);

/**
 * The engine's priority prompt names the turn position with its internal identifiers
 * ("You have priority (precombatMain)."). Rewrite only a parenthetical made of real phase/step
 * names, so any other prompt text passes through untouched.
 */
export function playerFacingPrompt(prompt: string): string {
  return prompt.replace(/\((\w+)(?:, (\w+))?\)/g, (match, phase: string, step?: string) => {
    if (!isPhase(phase)) return match;
    if (step === undefined) return `(${turnPositionLabel(phase, null)})`;
    return isStep(step) ? `(${turnPositionLabel(phase, step)})` : match;
  });
}

/** The verb on a priority action's button, from its type. Unknown types keep the engine's words. */
const PRIORITY_VERBS: Readonly<Record<string, string>> = {
  castSpell: 'Cast',
  playLand: 'Play',
  activateAbility: 'Activate',
  activateManaAbility: 'Tap for mana',
  pass: 'Pass',
  passAndYieldTurn: 'Pass and yield',
  yieldToAbility: 'Yield to ability',
  attackDeclaration: 'Declare attackers',
  blockDeclaration: 'Declare blockers',
};

/**
 * Actions whose `data` describes a cost, a variant or a mana ability: the ones the browser used
 * to label by reading it. Every other action's `data` is the AI's and the bot's, not a label.
 */
const LABELLED_TYPES: ReadonlySet<string> = new Set([
  'castSpell',
  'playLand',
  'activateAbility',
  'activateManaAbility',
]);

/** The fields ADR 0032 adds to one cast, land play, activation or by-hand mana ability. */
function labelFields(
  action: LegalAction,
  battlefieldIds: ReadonlySet<string>,
): Omit<ActionPresentation, 'verb' | 'subjects'> {
  const parts = actionLabelParts(action);
  const costLabels = actionCost(action);
  const family = xFamily(action);
  const symbols = action.type === 'activateManaAbility' ? manaSymbols(action) : [];
  // The seat's own permanents only: an id outside its projection would name something it
  // cannot see.
  const sourceIds = paymentSourceIds(action).filter((id) => battlefieldIds.has(id));
  const paymentSummary = paymentSourceSummary(action);
  return {
    label: parts.label,
    summary: pendingSummary(action),
    ...(costLabels.length > 0 ? { costLabels } : {}),
    ...(parts.entryNote !== null ? { entryNote: parts.entryNote } : {}),
    ...(family !== null ? { xFamily: family } : {}),
    ...(sourceIds.length > 0 || paymentSummary !== ''
      ? { payment: { sourceIds, summary: paymentSummary } }
      : {}),
    ...(symbols.length > 0 ? { manaSymbols: symbols } : {}),
    ...(parts.targetHint !== null ? { targetHint: parts.targetHint } : {}),
  };
}

/**
 * Adds presentation to a request about to be sent to one seat.
 *
 *   - A priority decision gets `layout: 'priority'` and one entry per action in its menu, with a
 *     verb from the action type and no subjects. An action the seat's smart yield removed is not
 *     in the menu, so it has no entry.
 *   - Any other decision keeps the engine's layout and entries; the new fields are added to the
 *     entries of its casts, land plays, activations and mana abilities.
 *   - Every decision gets `playerPrompt`.
 *
 * Returns a new request; the engine's own is never changed.
 */
export function enrichPresentation(
  request: DecisionRequest,
  board: PlayerBoardState,
): DecisionRequest {
  const isPriority = request.decisionType === 'priority';
  const existing = request.presentation;
  const battlefieldIds = new Set(board.battlefield.map((permanent) => permanent.id));
  const menu = new Set(request.legalActions.map((action) => action.id));

  const actions: Record<number, ActionPresentation> = {};
  // The engine's entries survive only for actions still on the menu.
  for (const [id, entry] of Object.entries(existing?.actions ?? {})) {
    if (menu.has(Number(id))) actions[Number(id)] = entry;
  }
  for (const action of request.legalActions) {
    const base = actions[action.id];
    const labelled = LABELLED_TYPES.has(action.type);
    if (base === undefined && !isPriority && !labelled) continue;
    const entry: ActionPresentation = base ?? {
      verb: PRIORITY_VERBS[action.type] ?? action.description,
      subjects: [],
    };
    actions[action.id] = labelled ? { ...entry, ...labelFields(action, battlefieldIds) } : entry;
  }

  const presentation: DecisionPresentation = {
    ...existing,
    layout: existing?.layout ?? (isPriority ? 'priority' : 'choices'),
    playerPrompt: playerFacingPrompt(request.prompt),
    ...(Object.keys(actions).length > 0 ? { actions } : {}),
  };
  return { ...request, presentation };
}

/** The "game over" line, in player terms. It names no halt reason: a policy decides those. */
export function gameOverSummary(result: GameResult): string {
  const turns = `${result.turnCount} turn${result.turnCount === 1 ? '' : 's'}`;
  if (result.halted) return `Game over — the game stopped after ${turns}`;
  return result.winnerSeat === null
    ? `Game over — draw after ${turns}`
    : `Game over — winner ${result.winnerSeat} after ${turns}`;
}

/**
 * Events as a player's log should narrate them. An elimination carries the engine's reason code
 * (`lifeZeroOrLess`); the log line is written from the player-facing words instead, so no
 * client rewrites the line afterwards.
 */
export function playerFacingEvents(events: readonly GameEvent[]): GameEvent[] {
  return events.map((event) => {
    const reason = event.payload['reason'];
    if (event.type !== 'playerEliminated' || typeof reason !== 'string') return event;
    return { ...event, payload: { ...event.payload, reason: lossReasonLabel(reason) } };
  });
}
