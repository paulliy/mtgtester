import type { ThreatAssessment } from './types';

/** Keep all urgent evidence even if that exceeds the soft nonurgent opponent budget. */
export function summarizeThreats(a: ThreatAssessment) {
  return {
    observer: a.observer,
    sequence: a.sequence,
    version: a.version,
    turn: a.turn,
    phase: a.phase,
    step: a.step,
    overallTopSet: a.overallTopSet,
    strategicTopSet: a.strategicTopSet,
    directTopSet: a.directTopSet,
    opponents: a.opponents
      .filter((o, i) => i < 3 || o.urgency < 4)
      .map((o) => ({
        seat: o.seat,
        score: o.strategicScore,
        range: o.scoreRange,
        urgency: o.urgency,
        urgent: o.urgentEvents,
        reasons: o.reasons,
        sources: o.sources.slice(0, 8),
        directDanger: o.directDanger,
        uncertainty: o.uncertainty.slice(0, 3),
      })),
    coverage: a.coverage,
    caution:
      'Scores are provisional, not win probabilities. Unknown is not safe. Ranking is not a target or action recommendation; preserve helpful third-party interventions and choose only legal actions.',
  };
}
