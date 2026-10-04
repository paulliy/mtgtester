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
  optionToActionId: Record<string, number>;
}

export interface JevUnsupportedRequest {
  kind: 'unsupported';
  classification: TacticalDecisionClassification;
}

export type JevActionBuildResult = JevActionRequest | JevUnsupportedRequest;

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevDecisionAdaptation =
  | {
      kind: 'accepted';
      response: DecisionResponse;
      confidence: number;
      probabilities: Record<string, number>;
      topTwoMargin: number;
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

/** Build a compact typed-decision request without the chat tactician primer. */
export function buildJevActionRequest(
  model: string,
  request: DecisionRequest,
  view: PlayerView,
  guidance?: TacticalGuidance,
  contextOptions: ContextOptions = {},
  maxActions?: number,
): JevActionBuildResult {
  const classification = classifyTacticalDecision(request, maxActions);
  if (!classification.jevSupported) return { kind: 'unsupported', classification };

  const assembled = assemblePrompt(request, view, guidance, contextOptions);
  const state = JSON.parse(assembled.messages[1]!.content) as Record<string, unknown>;
  delete state['legalActions'];
  const ctx = state['ctx'];
  if (typeof ctx === 'object' && ctx !== null && !Array.isArray(ctx)) {
    delete (ctx as Record<string, unknown>)['reqId'];
  }

  const optionToActionId: Record<string, number> = {};
  const criteria: Record<string, JevChoiceCriterion> = {};
  for (const action of request.legalActions) {
    const key = optionKey(action.id);
    optionToActionId[key] = action.id;
    const targets = forcedTargets(request, action.id);
    criteria[key] = {
      type: action.type,
      description: action.description,
      ...(targets === undefined ? {} : { forcedTargets: targets }),
      ...(action.data === undefined ? {} : { data: action.data }),
    };
  }

  return {
    kind: 'ready',
    logicalRequestId: request.requestId,
    classification,
    optionToActionId,
    request: {
      model,
      sessionId: `${request.gameId}:${request.requestId}`,
      state,
      questions: {
        action: {
          type: 'choice',
          instructions:
            "Choose the currently legal action that best advances this seat's stated strategy and survival. Select exactly one criterion key.",
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
  if (!validProbability(answer.confidence)) {
    return { kind: 'invalid', reason: 'confidence must be a finite value from 0 to 1' };
  }
  const expectedKeys = Object.keys(built.optionToActionId).sort();
  const actualKeys = Object.keys(answer.probabilities).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    return { kind: 'invalid', reason: 'probability options do not match the legal action map' };
  }
  const values = actualKeys.map((key) => answer.probabilities[key]);
  if (!values.every(validProbability)) {
    return { kind: 'invalid', reason: 'probabilities must be finite values from 0 to 1' };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.001) {
    return { kind: 'invalid', reason: 'probabilities must sum to 1' };
  }
  const actionId = built.optionToActionId[answer.choice];
  if (actionId === undefined)
    return { kind: 'invalid', reason: 'choice is not a legal action key' };
  const chosenProbability = answer.probabilities[answer.choice]!;
  if (chosenProbability + Number.EPSILON < Math.max(...values)) {
    return { kind: 'invalid', reason: 'choice does not have the highest reported probability' };
  }

  const sorted = [...values].sort((left, right) => right - left);
  const targets = forcedTargets(originalRequest, actionId);
  return {
    kind: 'accepted',
    response: {
      requestId: originalRequest.requestId,
      actionId,
      ...(targets === undefined ? {} : { targets }),
    },
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
    topTwoMargin: (sorted[0] ?? 0) - (sorted[1] ?? 0),
  };
}
