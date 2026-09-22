import type { DecisionRequest, PlayerView } from '@mtg/shared';
import { extractFeatures, feature, pressureMatrix, clamp } from './features';
import { detectUrgency } from './urgency';
import { score, TIE_BAND, SWITCH_MARGIN } from './score';
import { SCORING_VERSION, type ThreatAssessment, type OpponentAssessment } from './types';
export type { ThreatAssessment } from './types';

export function assessThreats(
  view: PlayerView,
  request: Pick<DecisionRequest, 'turn' | 'phase' | 'step'>,
  previous?: ThreatAssessment,
): ThreatAssessment {
  // Synthetic/replay views may retain eliminated seats. Remove them before pairwise estimates.
  if (view.threatFacts) {
    const liveSeats = new Set(view.threatFacts.turnOrder);
    view = {
      ...view,
      opponents: view.opponents.filter((o) => o.seat !== view.seat && liveSeats.has(o.seat)),
      battlefield: view.battlefield.filter((p) => liveSeats.has(p.controller)),
    };
  }
  const pressure = pressureMatrix(view);
  const urgent = detectUrgency(view);
  const live = view.threatFacts?.turnOrder;
  const opponents: OpponentAssessment[] = view.opponents
    .filter((o) => o.seat !== view.seat && (!live || live.includes(o.seat)))
    .map((o) => {
      const components = extractFeatures(view, o, pressure);
      const strength = score(components);
      const urgentEvents = urgent.filter((e) => e.controller === o.seat);
      const direct = pressure.find((p) => p.actor === o.seat && p.recipient === view.seat);
      const old =
        previous?.observer === view.seat
          ? previous.opponents.find((p) => p.seat === o.seat)
          : undefined;
      const sources = [...new Set(Object.values(components).flatMap((f) => f.sources))];
      return {
        seat: o.seat,
        rank: 0,
        tieGroup: 0,
        strategicScore: strength.value,
        scoreRange: strength.range,
        components,
        urgentEvents,
        urgency: Math.min(
          4,
          ...urgentEvents.map((e) => e.urgency),
        ) as OpponentAssessment['urgency'],
        directDanger: urgentEvents.some((e) => e.affected.includes(view.seat))
          ? 100
          : 100 * clamp((direct?.damage ?? 0) / Math.max(10, view.life)),
        interference: components.D,
        vulnerability: feature(
          view,
          clamp(1 - Math.max(0, o.life) / 40),
          'estimated',
          'Life exposure only; vulnerability is not a reason to attack.',
        ),
        reasons: [
          ...urgentEvents
            .slice(0, 1)
            .map(
              (e) =>
                `Possible elimination of ${e.affected.join(', ')}; respond ${e.deadline}; sources ${e.sources.join(', ')}.`,
            ),
          ...Object.values(components)
            .filter((f) => f.sources.length > 0 && (f.value ?? 0) > 0)
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
            .map((f) => f.reason),
          components.H.reason,
        ].slice(0, 3),
        sources,
        uncertainty: [
          ...new Set([
            ...Object.values(components)
              .filter((f) => f.status === 'unknown' || f.status === 'unsupported')
              .map((f) => f.reason),
            ...view.battlefield
              .filter((p) => p.controller === o.seat)
              .flatMap((p) => p.capabilities?.unsupported ?? ['missing-public-capabilities']),
          ]),
        ],
        changes: old
          ? [
              ...(old.strategicScore !== strength.value
                ? [
                    `Strategic score ${old.strategicScore} → ${strength.value}; public component values changed.`,
                  ]
                : []),
              ...old.sources
                .filter((id) => !sources.includes(id))
                .map((id) => `Source removed: ${id}`),
              ...sources
                .filter((id) => !old.sources.includes(id))
                .map((id) => `Source added: ${id}`),
            ]
          : [],
      };
    });
  const deadline = (o: OpponentAssessment): number =>
    Math.min(Infinity, ...o.urgentEvents.map((e) => e.deadlineOrder));
  opponents.sort(
    (a, b) =>
      a.urgency - b.urgency || deadline(a) - deadline(b) || b.strategicScore - a.strategicScore,
  );
  let group = 0,
    anchor: OpponentAssessment | undefined;
  opponents.forEach((o, index) => {
    if (
      !anchor ||
      o.urgency !== anchor.urgency ||
      deadline(o) !== deadline(anchor) ||
      anchor.strategicScore - o.strategicScore > TIE_BAND
    ) {
      group++;
      anchor = o;
    }
    o.rank = index + 1;
    o.tieGroup = group;
  });
  const first = opponents[0];
  // Intersecting score intervals are uncertainty, not statistical confidence intervals.
  const top = first
    ? opponents
        .filter(
          (o) =>
            o.urgency === first.urgency &&
            deadline(o) === deadline(first) &&
            (first.strategicScore - o.strategicScore <= TIE_BAND ||
              o.scoreRange[1] >= first.scoreRange[0]),
        )
        .map((o) => o.seat)
    : [];
  const strategicMax = Math.max(0, ...opponents.map((o) => o.strategicScore));
  const directMax = Math.max(0, ...opponents.map((o) => o.directDanger));
  let displayedLeader = first?.seat ?? null;
  const incumbent =
    previous?.observer === view.seat
      ? opponents.find((o) => o.seat === previous.displayedLeader)
      : undefined;
  if (
    first?.urgency === 4 &&
    incumbent?.urgency === 4 &&
    !incumbent.changes.some((c) => c.startsWith('Source removed')) &&
    first.strategicScore - incumbent.strategicScore < SWITCH_MARGIN
  )
    displayedLeader = incumbent.seat;
  return {
    observer: view.seat,
    sequence: view.threatFacts?.sequence ?? null,
    turn: view.threatFacts?.turn ?? request.turn,
    phase: view.threatFacts?.phase ?? request.phase,
    step: view.threatFacts ? view.threatFacts.step : request.step,
    version: SCORING_VERSION,
    opponents,
    pressure,
    overallTopSet: top,
    strategicTopSet: opponents
      .filter((o) => strategicMax - o.strategicScore <= TIE_BAND)
      .map((o) => o.seat),
    directTopSet:
      directMax > 0
        ? opponents.filter((o) => directMax - o.directDanger <= TIE_BAND).map((o) => o.seat)
        : [],
    interferenceTopSet: [],
    displayedLeader,
    coverage: [
      ...(view.threatFacts?.unsupported ?? ['missing-public-facts']),
      ...(view.threatFacts?.pressureTruncated ? ['truncated-pressure-history'] : []),
    ],
    search: urgent.length ? 'possible' : 'unknown',
  };
}

/** Bounded per-seat cache. Fingerprint consists exclusively of the already filtered view. */
export class ThreatTracker {
  private readonly entries = new Map<string, { key: string; assessment: ThreatAssessment }>();
  assess(
    view: PlayerView,
    request: Pick<DecisionRequest, 'turn' | 'phase' | 'step'>,
  ): { assessment: ThreatAssessment; cached: boolean } {
    // Do not fingerprint own deck/hand: threat ranking must not encode those private identities.
    const key = JSON.stringify([
      SCORING_VERSION,
      view.seat,
      request.turn,
      request.phase,
      request.step,
      view.life,
      view.opponents,
      view.battlefield,
      view.stack,
      view.threatFacts,
    ]);
    const previous = this.entries.get(view.seat);
    if (previous?.key === key) return { assessment: previous.assessment, cached: true };
    const assessment = assessThreats(view, request, previous?.assessment);
    this.entries.set(view.seat, { key, assessment });
    if (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value!);
    return { assessment, cached: false };
  }
}
