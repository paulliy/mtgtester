import type { DecisionRequest, DecisionType } from '@mtg/shared';

export const JEV_MAX_CHOICE_OPTIONS = 255;

export type TacticalDecisionShape =
  | 'action_only'
  | 'action_with_forced_targets'
  | 'expanded_targets'
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
  | 'supported_expanded_targets'
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
  /** Choice options Jev is offered: one per action, or one per action and target if expanded. */
  optionCount?: number;
}

export interface ClassifyOptions {
  /**
   * Offer each targeted action once per legal target when exactly one of its slots is undecided.
   * Off by default, which keeps the fail-closed V1 contract.
   */
  expandTargets?: boolean;
}

/**
 * Choice options for one action when targets are expanded: 1 when every slot is forced, the
 * undecided slot's option count when exactly one slot is undecided, and null when the action
 * cannot be expanded faithfully (two undecided slots, or an undecided slot that could repeat a
 * forced slot's object, which may need distinct targets).
 */
export function expandedOptionCount(action: {
  targets?: ReadonlyArray<{ slot: number; options: readonly string[] }>;
}): number | null {
  const slots = action.targets ?? [];
  const open = slots.filter((slot) => slot.options.length > 1);
  if (open.length === 0) return 1;
  if (open.length > 1) return null;
  const forced = new Set(
    slots.filter((slot) => slot.options.length === 1).map((s) => s.options[0]),
  );
  if (open[0]!.options.some((option) => forced.has(option))) return null;
  return open[0]!.options.length;
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
  options: ClassifyOptions = {},
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
    if (options.expandTargets === true) {
      const counts = request.legalActions.map(expandedOptionCount);
      const optionCount = counts.reduce<number | null>(
        (sum, count) => (sum === null || count === null ? null : sum + count),
        0,
      );
      if (optionCount !== null && optionCount <= effectiveMaxActions) {
        return {
          ...base,
          optionCount,
          shape: 'expanded_targets',
          jevSupported: true,
          reason: 'supported_expanded_targets',
        };
      }
    }
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
      optionCount: actionCount,
      shape: 'action_with_forced_targets',
      jevSupported: true,
      reason: 'supported_forced_targets',
    };
  }
  return {
    ...base,
    optionCount: actionCount,
    shape: 'action_only',
    jevSupported: true,
    reason: 'supported_action_only',
  };
}
