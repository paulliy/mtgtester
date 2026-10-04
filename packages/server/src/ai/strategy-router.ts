import type { DecisionRequest, PlayerView } from '@mtg/shared';
import type { BenchmarkRole } from '../benchmark/contracts';
import { extractStateFeatures, type StateFeatures } from './state-features';
import {
  eligibleCandidate,
  type PolicyCandidate,
  type PolicyHandler,
  type PolicyRegistry,
} from './policy-registry';

export type RouterReasonCode =
  | 'forced_supported_choice'
  | 'coupled_assignment'
  | 'unresolved_stack'
  | 'critical_interaction_window'
  | 'large_legal_branching'
  | 'unknown_action_type'
  | 'missing_critical_feature'
  | 'previous_plan_invalidation'
  | 'ordinary_supported_state'
  | 'no_evaluated_candidate';

export interface StrategyRoute {
  version: 'interpretable-router-v1';
  role: BenchmarkRole;
  initialHandler: PolicyHandler;
  finalHandler: PolicyHandler;
  candidate: PolicyCandidate | null;
  reasons: RouterReasonCode[];
  featureDurationMs: number;
  features: StateFeatures;
  shadowOnly: boolean;
  recovery: 'none' | 'fixed_baseline' | 'bounded_stronger_escalation';
}

export interface RouterInput {
  role: BenchmarkRole;
  request: DecisionRequest;
  view: PlayerView;
  registry: PolicyRegistry;
  previousRelevantPlanInvalidations?: number;
  shadowOnly?: boolean;
  maxFeatureMs?: number;
}

const KNOWN_ACTION_TYPES = new Set([
  'pass',
  'castSpell',
  'playLand',
  'activateAbility',
  'chooseTargets',
  'chooseMode',
  'chooseValue',
  'declareAttackers',
  'declareBlockers',
  'order',
  'keep',
  'mulligan',
]);

function candidateFor(
  registry: PolicyRegistry,
  handler: PolicyHandler,
  role: BenchmarkRole,
  decisionType: string,
): PolicyCandidate | null {
  return eligibleCandidate(registry, handler, role, decisionType);
}

export function routeStrategy(input: RouterInput): StrategyRoute {
  const start = performance.now();
  const features = extractStateFeatures(input.request, input.view);
  const featureDurationMs = performance.now() - start;
  const reasons: RouterReasonCode[] = [];
  const unknownAction = input.request.legalActions.some(
    (action) => !KNOWN_ACTION_TYPES.has(action.type),
  );
  const coupled =
    input.request.manaSplit !== undefined ||
    input.request.combatDamageSplit !== undefined ||
    input.request.legalActions.some((action) => (action.targets?.length ?? 0) > 1);
  const critical =
    input.view.stack.length > 0 ||
    input.request.legalActions.some((action) =>
      ['counterSpell', 'chooseTargets'].includes(action.type),
    );
  const featureOverBudget = featureDurationMs > (input.maxFeatureMs ?? 5);

  let handler: PolicyHandler;
  if (unknownAction || featureOverBudget) {
    handler = 'unsupported';
    reasons.push(unknownAction ? 'unknown_action_type' : 'missing_critical_feature');
  } else if (input.request.legalActions.length === 1 && !coupled) {
    handler = 'deterministic';
    reasons.push('forced_supported_choice');
  } else if (
    coupled ||
    critical ||
    input.request.legalActions.length >= 16 ||
    (input.previousRelevantPlanInvalidations ?? 0) > 0
  ) {
    handler = 'stronger';
    if (coupled) reasons.push('coupled_assignment');
    if (input.view.stack.length > 0) reasons.push('unresolved_stack');
    if (critical) reasons.push('critical_interaction_window');
    if (input.request.legalActions.length >= 16) reasons.push('large_legal_branching');
    if ((input.previousRelevantPlanInvalidations ?? 0) > 0) {
      reasons.push('previous_plan_invalidation');
    }
  } else {
    handler = 'economical';
    reasons.push('ordinary_supported_state');
  }

  const candidate = candidateFor(input.registry, handler, input.role, input.request.decisionType);
  if (candidate === null) reasons.push('no_evaluated_candidate');
  return {
    version: 'interpretable-router-v1',
    role: input.role,
    initialHandler: handler,
    finalHandler: candidate === null ? 'unsupported' : handler,
    candidate,
    reasons,
    featureDurationMs,
    features,
    shadowOnly: input.shadowOnly ?? true,
    recovery:
      handler === 'economical' && candidate !== null
        ? 'bounded_stronger_escalation'
        : candidate === null
          ? 'fixed_baseline'
          : 'none',
  };
}

export function escalateRoute(
  route: StrategyRoute,
  registry: PolicyRegistry,
  decisionType: string,
  outcome: 'invalid' | 'timeout' | 'unsupported' | 'board_changed',
  deadlineRemainingMs: number,
): StrategyRoute {
  if (
    route.initialHandler !== 'economical' ||
    deadlineRemainingMs <= 0 ||
    !['invalid', 'timeout', 'unsupported', 'board_changed'].includes(outcome)
  ) {
    return route;
  }
  const stronger = candidateFor(registry, 'stronger', route.role, decisionType);
  return {
    ...route,
    finalHandler: stronger === null ? 'unsupported' : 'stronger',
    candidate: stronger,
    recovery: stronger === null ? 'fixed_baseline' : 'none',
    reasons:
      stronger === null && !route.reasons.includes('no_evaluated_candidate')
        ? [...route.reasons, 'no_evaluated_candidate']
        : route.reasons,
  };
}

export interface RouterShadowSummary {
  total: number;
  byHandler: Record<PolicyHandler, number>;
  unsupported: number;
  underRoutedCritical: number;
  unnecessaryEscalations: number;
}

export function summarizeShadowRoutes(routes: readonly StrategyRoute[]): RouterShadowSummary {
  const byHandler: Record<PolicyHandler, number> = {
    deterministic: 0,
    economical: 0,
    stronger: 0,
    unsupported: 0,
  };
  for (const route of routes) byHandler[route.finalHandler]++;
  return {
    total: routes.length,
    byHandler,
    unsupported: byHandler.unsupported,
    underRoutedCritical: routes.filter(
      (route) =>
        route.initialHandler === 'economical' &&
        route.reasons.includes('critical_interaction_window'),
    ).length,
    unnecessaryEscalations: routes.filter(
      (route) =>
        route.initialHandler === 'stronger' &&
        route.reasons.length === 1 &&
        route.reasons[0] === 'large_legal_branching',
    ).length,
  };
}
