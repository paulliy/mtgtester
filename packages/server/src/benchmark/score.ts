import type { DecisionResponse, TurnStrategy } from '@mtg/shared';
import type {
  BenchmarkCase,
  BenchmarkScore,
  StrategicGold,
  TacticalGold,
  TacticalPattern,
} from './contracts';
import { canonicalJson } from './hash';

function sortedRecord(
  value: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

/** Canonicalizes only proven non-semantic ordering; target slots and assignments remain explicit. */
export function semanticDecisionKey(response: DecisionResponse): string {
  return canonicalJson({
    actionId: response.actionId,
    targets: response.targets?.map((target) => ({ slot: target.slot, choice: target.choice })),
    manaSplit: sortedRecord(response.manaSplit),
    combatDamageSplit: sortedRecord(response.combatDamageSplit),
    turnStrategy:
      response.turnStrategy === undefined
        ? undefined
        : {
            intent: response.turnStrategy.intent,
            threatOrder: response.turnStrategy.threatOrder,
            manaPlan: response.turnStrategy.manaPlan,
            plannedActions: response.turnStrategy.plannedActions,
          },
  });
}

function patternKey(pattern: TacticalPattern): string {
  return canonicalJson({
    actionId: pattern.actionId,
    targets: pattern.targets,
    manaSplit: sortedRecord(pattern.manaSplit),
    combatDamageSplit: sortedRecord(pattern.combatDamageSplit),
  });
}

function tacticalScore(gold: TacticalGold, response: DecisionResponse): BenchmarkScore {
  const acceptable = gold.acceptable.some(
    (pattern) => patternKey(pattern) === semanticDecisionKey(response),
  );
  return {
    labelStatus: 'scored',
    acceptable,
    value: acceptable ? 1 : 0,
    metrics: { tier: gold.tier, exactSemanticMatch: acceptable },
  };
}

function strategistScore(gold: StrategicGold, strategy: TurnStrategy | undefined): BenchmarkScore {
  if (strategy === undefined) {
    return { labelStatus: 'scored', acceptable: false, value: 0, metrics: { usablePlan: false } };
  }
  const threats = new Set(strategy.threatOrder ?? []);
  const critical = gold.criticalThreats ?? [];
  const ignoredCriticalThreats = critical.filter((seat) => !threats.has(seat)).length;
  const topThreat = strategy.threatOrder?.[0];
  const topThreatAccepted =
    gold.acceptableTopThreats === undefined ||
    (topThreat !== undefined && gold.acceptableTopThreats.includes(topThreat));
  const objective = `${strategy.intent} ${strategy.manaPlan ?? ''}`.toLowerCase();
  const required = gold.requiredObjectives ?? [];
  const forbidden = gold.forbiddenObjectives ?? [];
  const requiredHit = required.filter((term) => objective.includes(term.toLowerCase())).length;
  const forbiddenHit = forbidden.filter((term) => objective.includes(term.toLowerCase())).length;
  const acceptable =
    ignoredCriticalThreats === 0 &&
    topThreatAccepted &&
    requiredHit === required.length &&
    forbiddenHit === 0;
  return {
    labelStatus: 'scored',
    acceptable,
    value: acceptable ? 1 : 0,
    metrics: {
      usablePlan: true,
      ignoredCriticalThreats,
      topThreatAccepted,
      requiredHit,
      forbiddenHit,
    },
  };
}

export function scoreResponse(
  caseValue: BenchmarkCase,
  response: DecisionResponse,
): BenchmarkScore {
  if (caseValue.gold === undefined) return { labelStatus: 'unscored', metrics: {} };
  return caseValue.role === 'tactician'
    ? tacticalScore(caseValue.gold, response)
    : strategistScore(caseValue.gold, response.turnStrategy);
}
