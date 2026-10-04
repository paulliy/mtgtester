import type { DecisionRequest, DecisionType } from '@mtg/shared';

export const JEV_MAX_CHOICE_OPTIONS = 255;

export type TacticalDecisionShape =
  | 'action_only'
  | 'action_with_forced_targets'
  | 'ambiguous_targets'
  | 'coupled_assignment'
  | 'distribution'
  | 'ordering_or_value'
  | 'too_many_actions'
  | 'malformed_menu'
  | 'unsupported_decision_type';

export type JevSupportReason =
  | 'supported_action_only'
  | 'supported_forced_targets'
  | 'requires_ambiguous_target_choice'
  | 'requires_coupled_assignment'
  | 'requires_distribution'
  | 'requires_order_mode_or_value'
  | 'choice_option_limit_exceeded'
  | 'menu_is_empty_or_malformed'
  | 'decision_type_not_supported';

export interface TacticalDecisionClassification {
  shape: TacticalDecisionShape;
  jevSupported: boolean;
  reason: JevSupportReason;
  actionCount: number;
  targetSlotCount: number;
}

const JEV_V1_DECISION_TYPES = new Set<DecisionType>([
  'priority',
  'mulligan',
  'optionalTrigger',
  'commanderReplacement',
  'legendRule',
  'general',
]);

/**
 * Fail-closed classifier for Jev V1. A supported decision must be completely materializable from
 * one action Choice answer; Jev is never asked to invent another response field.
 */
export function classifyTacticalDecision(
  request: DecisionRequest,
  maxActions = JEV_MAX_CHOICE_OPTIONS,
): TacticalDecisionClassification {
  const actionCount = request.legalActions.length;
  const targetSlotCount = request.legalActions.reduce(
    (sum, action) => sum + (action.targets?.length ?? 0),
    0,
  );
  const base = { actionCount, targetSlotCount };

  if (
    actionCount === 0 ||
    new Set(request.legalActions.map((action) => action.id)).size !== actionCount
  ) {
    return {
      ...base,
      shape: 'malformed_menu',
      jevSupported: false,
      reason: 'menu_is_empty_or_malformed',
    };
  }
  const effectiveMaxActions = Math.max(1, Math.min(JEV_MAX_CHOICE_OPTIONS, maxActions));
  if (actionCount > effectiveMaxActions) {
    return {
      ...base,
      shape: 'too_many_actions',
      jevSupported: false,
      reason: 'choice_option_limit_exceeded',
    };
  }
  if (request.manaSplit !== undefined || request.combatDamageSplit !== undefined) {
    return {
      ...base,
      shape: 'distribution',
      jevSupported: false,
      reason: 'requires_distribution',
    };
  }
  if (request.decisionType === 'declareAttackers' || request.decisionType === 'declareBlockers') {
    return {
      ...base,
      shape: 'coupled_assignment',
      jevSupported: false,
      reason: 'requires_coupled_assignment',
    };
  }
  if (
    request.decisionType === 'chooseModes' ||
    request.decisionType === 'chooseX' ||
    request.decisionType === 'orderTriggers' ||
    request.decisionType === 'bottomCards' ||
    request.decisionType === 'assignCombatDamage'
  ) {
    return {
      ...base,
      shape: 'ordering_or_value',
      jevSupported: false,
      reason: 'requires_order_mode_or_value',
    };
  }
  if (!JEV_V1_DECISION_TYPES.has(request.decisionType)) {
    return {
      ...base,
      shape: 'unsupported_decision_type',
      jevSupported: false,
      reason: 'decision_type_not_supported',
    };
  }

  const slots = request.legalActions.flatMap((action) => action.targets ?? []);
  if (slots.some((slot) => slot.options.length === 0)) {
    return {
      ...base,
      shape: 'malformed_menu',
      jevSupported: false,
      reason: 'menu_is_empty_or_malformed',
    };
  }
  if (slots.some((slot) => slot.options.length > 1)) {
    return {
      ...base,
      shape: 'ambiguous_targets',
      jevSupported: false,
      reason: 'requires_ambiguous_target_choice',
    };
  }
  if (slots.length > 0) {
    return {
      ...base,
      shape: 'action_with_forced_targets',
      jevSupported: true,
      reason: 'supported_forced_targets',
    };
  }
  return {
    ...base,
    shape: 'action_only',
    jevSupported: true,
    reason: 'supported_action_only',
  };
}
