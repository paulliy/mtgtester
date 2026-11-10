import type { DecisionRequest, DecisionResponse, PlayerView, TargetChoice } from '@mtg/shared';
import { assemblePrompt, type ContextOptions, type TacticalGuidance } from './context';
import {
  classifyTacticalDecision,
  type TacticalDecisionClassification,
} from './tactical-decision-shape';

export interface JevChoiceCriterion {
  type: string;
  description: string;
  forcedTargets?: TargetChoice[];
  /** Expanded options: the full target list this option submits. */
  targets?: TargetChoice[];
  /** Expanded options: the public object or player the undecided slot names. */
  target?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, JevChoiceCriterion>;
}

export interface JevDecisionsRequest {
  model: string;
  state: Record<string, unknown>;
  questions: { action: JevChoiceQuestion };
  sessionId?: string;
}

export interface JevActionRequest {
  kind: 'ready';
  logicalRequestId: string;
  classification: TacticalDecisionClassification;
  request: JevDecisionsRequest;
  /** Each option key's action. Several keys share an action when its targets are expanded. */
  optionToActionId: Record<string, number>;
  /** Each option key's complete target list, when the action has targets. */
  optionToTargets?: Record<string, TargetChoice[]>;
}

export interface JevUnsupportedRequest {
  kind: 'unsupported';
  classification: TacticalDecisionClassification;
}

export type JevActionBuildResult = JevActionRequest | JevUnsupportedRequest;

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  /** Optional in the Decisions API. */
  confidence?: number;
  /** Optional in the Decisions API, and may cover only some options (absent keys count as 0). */
  probabilities?: Record<string, number>;
}

export type JevDecisionAdaptation =
  | {
      kind: 'accepted';
      response: DecisionResponse;
      /** Reported confidence, else the chosen option's probability, else null (unknown). */
      confidence: number | null;
      probabilities: Record<string, number>;
      /** Null when no probabilities were reported. */
      topTwoMargin: number | null;
    }
  | { kind: 'invalid'; reason: string };

function optionKey(actionId: number): string {
  return `action_${actionId}`;
}

function forcedTargets(request: DecisionRequest, actionId: number): TargetChoice[] | undefined {
  const action = request.legalActions.find((candidate) => candidate.id === actionId);
  const targets = action?.targets?.map((slot) => ({ slot: slot.slot, choice: slot.options[0]! }));
  return targets === undefined || targets.length === 0 ? undefined : targets;
}

export interface JevBuildOptions {
  contextOptions?: ContextOptions;
  maxActions?: number;
  /** Offer a targeted action once per legal target (see `ClassifyOptions.expandTargets`). */
  expandTargets?: boolean;
  /** Overrides the default Choice instructions, e.g. to describe a close call. */
  instructions?: string;
}

export const JEV_DEFAULT_INSTRUCTIONS =
  "Choose the currently legal action that best advances this seat's stated strategy and survival. Select exactly one criterion key.";

/** Public names for object ids a target can name: permanents, stack objects, players, cards. */
function targetLabels(view: PlayerView): Map<string, Record<string, unknown>> {
  const labels = new Map<string, Record<string, unknown>>();
  for (const perm of view.battlefield) {
    labels.set(perm.id, {
      name: perm.name,
      controller: perm.controller,
      ...(perm.power !== undefined ? { p: perm.power, t: perm.toughness } : {}),
    });
  }
  for (const item of view.stack) {
    labels.set(item.id, { name: item.description, controller: item.controller, zone: 'stack' });
  }
  labels.set(view.seat, { player: view.seat, you: true, life: view.life });
  for (const opp of view.opponents) labels.set(opp.seat, { player: opp.seat, life: opp.life });
  for (const card of view.hand) labels.set(card.id, { name: card.name, zone: 'hand' });
  for (const card of view.graveyard) labels.set(card.id, { name: card.name, zone: 'graveyard' });
  for (const opp of view.opponents) {
    for (const card of opp.graveyard) {
      labels.set(card.id, { name: card.name, zone: 'graveyard', owner: opp.seat });
    }
  }
  return labels;
}

/**
 * Build a compact typed-decision request without the chat tactician primer.
 *
 * The positional `contextOptions` and `maxActions` arguments are kept for existing callers;
 * `buildOptions` adds target expansion and custom instructions.
 */
export function buildJevActionRequest(
  model: string,
  request: DecisionRequest,
  view: PlayerView,
  guidance?: TacticalGuidance,
  contextOptions: ContextOptions = {},
  maxActions?: number,
  buildOptions: JevBuildOptions = {},
): JevActionBuildResult {
  const classification = classifyTacticalDecision(request, maxActions, {
    expandTargets: buildOptions.expandTargets === true,
  });
  if (!classification.jevSupported) return { kind: 'unsupported', classification };

  const assembled = assemblePrompt(request, view, guidance, contextOptions);
  const state = JSON.parse(assembled.messages[1]!.content) as Record<string, unknown>;
  delete state['legalActions'];
  const ctx = state['ctx'];
  if (typeof ctx === 'object' && ctx !== null && !Array.isArray(ctx)) {
    delete (ctx as Record<string, unknown>)['reqId'];
  }

  const labels = classification.shape === 'expanded_targets' ? targetLabels(view) : null;
  const optionToActionId: Record<string, number> = {};
  const optionToTargets: Record<string, TargetChoice[]> = {};
  const criteria: Record<string, JevChoiceCriterion> = {};
  for (const action of request.legalActions) {
    const base = {
      type: action.type,
      description: action.description,
      ...(action.data === undefined ? {} : { data: action.data }),
    };
    const open = action.targets?.find((slot) => slot.options.length > 1);
    if (labels === null || open === undefined) {
      const key = optionKey(action.id);
      optionToActionId[key] = action.id;
      const targets = forcedTargets(request, action.id);
      if (targets !== undefined) optionToTargets[key] = targets;
      criteria[key] = { ...base, ...(targets === undefined ? {} : { forcedTargets: targets }) };
      continue;
    }
    // One option per legal object for the single undecided slot; other slots are forced.
    open.options.forEach((choice, index) => {
      const key = `${optionKey(action.id)}_t${index}`;
      const targets = (action.targets ?? []).map((slot) => ({
        slot: slot.slot,
        choice: slot.slot === open.slot ? choice : slot.options[0]!,
      }));
      optionToActionId[key] = action.id;
      optionToTargets[key] = targets;
      criteria[key] = {
        ...base,
        targets,
        target: { id: choice, ...(labels.get(choice) ?? {}) },
      };
    });
  }

  return {
    kind: 'ready',
    logicalRequestId: request.requestId,
    classification,
    optionToActionId,
    ...(Object.keys(optionToTargets).length === 0 ? {} : { optionToTargets }),
    request: {
      model,
      sessionId: `${request.gameId}:${request.requestId}`,
      state,
      questions: {
        action: {
          type: 'choice',
          instructions: buildOptions.instructions ?? JEV_DEFAULT_INSTRUCTIONS,
          criteria,
        },
      },
    },
  };
}

function validProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Convert a typed Jev Choice answer into the engine protocol without trusting remote fields. */
export function adaptJevActionAnswer(
  built: JevActionRequest,
  originalRequest: DecisionRequest,
  answer: JevChoiceAnswer,
): JevDecisionAdaptation {
  if (answer.type !== 'choice') return { kind: 'invalid', reason: 'answer type is not choice' };
  if (answer.confidence !== undefined && !validProbability(answer.confidence)) {
    return { kind: 'invalid', reason: 'confidence must be a finite value from 0 to 1' };
  }
  const actionId = built.optionToActionId[answer.choice];
  if (actionId === undefined)
    return { kind: 'invalid', reason: 'choice is not a legal action key' };

  // Probabilities may list only some options; every listed key must be a real option.
  const probabilities = answer.probabilities ?? {};
  const reported = Object.keys(probabilities);
  if (reported.some((key) => built.optionToActionId[key] === undefined)) {
    return { kind: 'invalid', reason: 'probability options do not match the legal action map' };
  }
  const values = reported.map((key) => probabilities[key]);
  if (!values.every(validProbability)) {
    return { kind: 'invalid', reason: 'probabilities must be finite values from 0 to 1' };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (sum > 1.001) return { kind: 'invalid', reason: 'probabilities sum to more than 1' };
  if (reported.length === Object.keys(built.optionToActionId).length && Math.abs(sum - 1) > 0.001) {
    return { kind: 'invalid', reason: 'probabilities must sum to 1' };
  }
  const chosenProbability = probabilities[answer.choice] ?? 0;
  if (reported.length > 0 && chosenProbability + Number.EPSILON < Math.max(...values)) {
    return { kind: 'invalid', reason: 'choice does not have the highest reported probability' };
  }

  const sorted = [...values].sort((left, right) => right - left);
  const targets =
    built.optionToTargets?.[answer.choice] ?? forcedTargets(originalRequest, actionId);
  const confidence = answer.confidence ?? (reported.length > 0 ? chosenProbability : null);
  return {
    kind: 'accepted',
    response: {
      requestId: originalRequest.requestId,
      actionId,
      ...(targets === undefined ? {} : { targets: targets.map((target) => ({ ...target })) }),
    },
    confidence,
    probabilities: { ...probabilities },
    topTwoMargin: reported.length === 0 ? null : (sorted[0] ?? 0) - (sorted[1] ?? 0),
  };
}
