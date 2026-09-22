import type { DecisionRequest, PlayerView, TurnStrategy } from '@mtg/shared';
import { assembleStrategistPrompt, type AiPrompt } from '../context';
import { assessThreats } from './index';
import type { ThreatCase } from './fixtures';

/** Development diagnostics only. Acceptable sets are authored independently of scorer weights. */
export function evaluateCases(cases: readonly ThreatCase[], request: DecisionRequest) {
  const rows = cases.map((c) => {
    const a = assessThreats(c.view, request);
    const predicted = a.opponents[0]?.seat;
    const urgent = a.opponents.filter((o) => o.urgency < 4).map((o) => o.seat);
    const rawPower = [...c.view.opponents].sort((x, y) => {
      const power = (seat: string) =>
        c.view.battlefield
          .filter((p) => p.controller === seat)
          .reduce((n, p) => n + Math.max(0, p.power ?? 0), 0);
      return power(y.seat) - power(x.seat);
    })[0]?.seat;
    const resourceCount = [...c.view.opponents].sort((x, y) => {
      const resources = (seat: string, hand: number) =>
        c.view.battlefield.filter((p) => p.controller === seat).length + hand;
      return resources(y.seat, y.handSize) - resources(x.seat, x.handSize);
    })[0]?.seat;
    return {
      name: c.name,
      category: c.category,
      rawLeaderAcceptable: predicted !== undefined && c.acceptable.includes(predicted),
      powerBaselineAcceptable: rawPower !== undefined && c.acceptable.includes(rawPower),
      resourcesBaselineAcceptable:
        resourceCount !== undefined && c.acceptable.includes(resourceCount),
      abstained: a.overallTopSet.length !== 1,
      missedCritical: c.urgent.filter((seat) => !urgent.includes(seat)).length,
      falseUrgent: urgent.filter((seat) => !c.urgent.includes(seat)).length,
      coverage: a.coverage,
    };
  });
  const count = rows.length;
  const rate = (values: boolean[]) => (count ? values.filter(Boolean).length / count : null);
  return {
    labelStatus: 'development-only-not-independent-review',
    count,
    rawLeaderAcceptableRate: rate(rows.map((r) => r.rawLeaderAcceptable)),
    powerBaselineAcceptableRate: rate(rows.map((r) => r.powerBaselineAcceptable)),
    resourcesBaselineAcceptableRate: rate(rows.map((r) => r.resourcesBaselineAcceptable)),
    abstentionRate: rate(rows.map((r) => r.abstained)),
    missedCritical: rows.reduce((n, r) => n + r.missedCritical, 0),
    falseUrgent: rows.reduce((n, r) => n + r.falseUrgent, 0),
    rows,
  };
}

export interface StrategistCase {
  id: string;
  /** Cluster related positions by original source game/deck family before any split. */
  sourceGroup: string;
  request: DecisionRequest;
  view: PlayerView;
}
/** Adapter owns a frozen model/settings/output budget for both arms. No network dependency here. */
export type StrategistTrial = (prompt: AiPrompt, request: DecisionRequest) => Promise<TurnStrategy>;
export async function pairedStrategistTrials(
  cases: readonly StrategistCase[],
  trial: StrategistTrial,
  repeats = 3,
) {
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error('repeats must be a positive integer');
  const rows: {
    caseId: string;
    sourceGroup: string;
    repeat: number;
    arm: 'baseline' | 'threat';
    strategy: TurnStrategy;
  }[] = [];
  for (const c of cases) {
    const assessment = assessThreats(c.view, c.request);
    const prompts = {
      baseline: assembleStrategistPrompt(c.request, c.view, []),
      threat: assembleStrategistPrompt(c.request, c.view, [], undefined, assessment),
    };
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Alternate ordering to avoid systematically putting one arm first.
      const arms =
        repeat % 2 ? (['threat', 'baseline'] as const) : (['baseline', 'threat'] as const);
      for (const arm of arms)
        rows.push({
          caseId: c.id,
          sourceGroup: c.sourceGroup,
          repeat,
          arm,
          strategy: await trial(structuredClone(prompts[arm]), structuredClone(c.request)),
        });
    }
  }
  return rows;
}
