/**
 * Per-model numbers, kept in three separate groups because they answer three separate questions:
 * accuracy (did it choose well, and legally), speed (how long a decision takes) and cost (what a
 * decision is billed). Nothing here blends them into one figure; that weighting is the judge's.
 */
import type { BenchCase } from './case';
import type { DecisionRecord, StrategistCall } from './play';
import type { ModelResult } from './run';

/**
 * Decisions used to project a per-game figure. ADR 0010 logged 320 surfaced decisions in a
 * 30-turn four-player game; 300 is that order of magnitude, stated so a reader can rescale it.
 */
export const DECISIONS_PER_GAME = 300;

export interface AccuracyMetrics {
  /** Mean case score, 0 to 1, over every case and trial the model played. */
  overall: number | null;
  single: number | null;
  /**
   * One-decision cases without those a decision model's seat handed to the bot (attacks,
   * blocks): the model's own choices only. Equal to `single` for every other kind of entry.
   */
  singleOwn: number | null;
  turn: number | null;
  casesPlayed: number;
  casesExpected: number;
  /** One-decision cases by the grade of the answer given. */
  grades: { best: number; good: number; weak: number; blunder: number; noAnswer: number };
  objectivesMet: number;
  objectivesTotal: number;
}

export interface ReliabilityMetrics {
  decisions: number;
  /** Decisions the model answered legally on its first response. */
  firstTryLegal: number;
  /**
   * Decisions a decision model's seat handed to the heuristic bot because no Choice can express
   * them (attacks, blocks). Not the model's answers: left out of `firstTryLegal` and of speed.
   */
  botAnswered: number;
  correctiveRetries: number;
  /** Decisions the heuristic bot answered because the model never produced a legal answer. */
  fallbacks: number;
  /** Answers the validator or the engine refused. */
  refused: number;
  providerErrors: number;
  /** Whole-turn cases cut off for making too many decisions. */
  decisionCaps: number;
  /** Share of cases where every trial chose the same actions; null with one trial. */
  consistency: number | null;
}

export interface SpeedMetrics {
  /** Decisions that involved the model or a local policy (every decision asked). */
  decisions: number;
  meanMs: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  maxMs: number | null;
  /** Mean time to finish one whole-turn case: the sum of its decisions. */
  meanTurnMs: number | null;
  totalDecisionMs: number;
}

export interface CostMetrics {
  /**
   * Null when the provider reported nothing and the lineup gave no price. With `source:
   * 'partial'` it is a lower bound: the sum of the priced decisions only.
   */
  totalUsd: number | null;
  /** `partial`: some billed decisions have a price and some do not. */
  source: 'reported' | 'estimated' | 'mixed' | 'partial' | 'unknown' | 'free';
  /** Mean over the priced decisions; an unpriced decision is never counted as free. */
  perDecisionUsd: number | null;
  /** `perDecisionUsd` times `DECISIONS_PER_GAME`. */
  perGameUsd: number | null;
  /** Decisions that made a provider request but have no price, reported or estimated. */
  unpricedDecisions: number;
  promptTokens: number;
  responseTokens: number;
  promptTokensPerDecision: number | null;
  responseTokensPerDecision: number | null;
  providerRequests: number;
}

/**
 * A live strategist's share, kept out of the other groups: speed and cost there stay the
 * tactician's, so a cell can be compared with its tactician's `none` row on the same terms.
 */
export interface StrategistMetrics {
  /** Strategist calls the seat waited for, re-plans and calls a case ended before included. */
  calls: number;
  /** Calls that installed no strategy: the provider failed or the answer was unusable. */
  failures: number;
  providerErrors: number;
  /** The seat's decisions played straight from the strategist's planned steps. */
  planSteps: number;
  meanWaitMs: number | null;
  p90WaitMs: number | null;
  /** Null when no call has a price; with `source: 'partial'`, the priced calls only. */
  totalUsd: number | null;
  source: CostMetrics['source'];
  perCallUsd: number | null;
  promptTokens: number;
  responseTokens: number;
  providerRequests: number;
  /**
   * The tactician's and the strategist's spending together: what the pair costs. Null when either
   * half is unknown.
   */
  combinedUsd: number | null;
}

export interface ModelMetrics {
  modelId: string;
  label: string;
  kind: string;
  status: ModelResult['status'];
  abortReason?: string;
  accuracy: AccuracyMetrics;
  reliability: ReliabilityMetrics;
  speed: SpeedMetrics;
  cost: CostMetrics;
  /** Entries with a live strategist only. */
  strategist?: StrategistMetrics;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank percentile: the smallest value at or above the given share of the sample. */
export function percentile(values: readonly number[], share: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))]!;
}

export function modelMetrics(
  result: ModelResult,
  cases: readonly BenchCase[],
  trials: number,
): ModelMetrics {
  const scope = new Map(cases.map((benchCase) => [benchCase.id, benchCase.scope]));
  const played = result.cases;
  const single = played.filter((entry) => scope.get(entry.caseId) === 'single');
  const turn = played.filter((entry) => scope.get(entry.caseId) === 'turn');
  const decisions = played.flatMap((entry) => entry.run.decisions);

  const grades = { best: 0, good: 0, weak: 0, blunder: 0, noAnswer: 0 };
  for (const entry of single) {
    const decision = entry.run.decisions[0];
    const own =
      decision !== undefined && decision.invalid === undefined && decision.source !== 'fallback';
    if (!own || entry.score.graded === undefined) grades.noAnswer += 1;
    else grades[entry.score.graded.grade] += 1;
  }
  const objectives = turn.flatMap((entry) => entry.score.objectives ?? []);

  const asked = decisions.filter(
    (decision) => decision.source !== 'script' && decision.source !== 'bot-handoff',
  );
  const latencies = asked.map((decision) => decision.latencyMs);
  const byCase = new Map<string, string[]>();
  for (const entry of played) {
    const key = entry.run.decisions.map((decision) => decision.actionKey).join(' | ');
    byCase.set(entry.caseId, [...(byCase.get(entry.caseId) ?? []), key]);
  }
  const repeated = [...byCase.values()].filter((keys) => keys.length > 1);

  // Spending counts every decision that was paid for, including a case the spend cap cut off,
  // which is not scored.
  const paid = [...decisions, ...(result.unscored ?? []).flatMap((entry) => entry.decisions)];
  const billable = paid.filter((decision) => decision.requests > 0);
  const known = billable.filter((decision) => decision.costUsd !== undefined);
  const totalUsd =
    billable.length === 0
      ? 0
      : known.length === 0
        ? null
        : known.reduce((sum, decision) => sum + (decision.costUsd ?? 0), 0);
  const unpricedDecisions = billable.length - known.length;
  const pricedSources = new Set(known.map((decision) => decision.costSource));
  const costSource: CostMetrics['source'] =
    billable.length === 0
      ? 'free'
      : known.length === 0
        ? 'unknown'
        : unpricedDecisions > 0
          ? 'partial'
          : pricedSources.size === 1
            ? (pricedSources.values().next().value as 'reported' | 'estimated')
            : 'mixed';
  const promptTokens = paid.reduce((sum, decision) => sum + (decision.promptTokens ?? 0), 0);
  const responseTokens = paid.reduce((sum, d) => sum + (d.responseTokens ?? 0), 0);
  // Averaged over the priced decisions only: dividing by every billed decision would count the
  // unpriced ones as free and make a model with incomplete billing look cheaper.
  const perDecisionUsd =
    totalUsd === null ? null : billable.length === 0 ? 0 : totalUsd / known.length;

  const strategistCalls: StrategistCall[] = [
    ...paid.flatMap((decision) => (decision.strategist === undefined ? [] : [decision.strategist])),
    ...played.flatMap((entry) =>
      entry.run.strategistTail === undefined ? [] : [entry.run.strategistTail],
    ),
    ...(result.unscored ?? []).flatMap((entry) =>
      entry.strategistTail === undefined ? [] : [entry.strategistTail],
    ),
  ];
  const strategist = isCandidateWithStrategist(result)
    ? strategistMetrics(strategistCalls, decisions, totalUsd)
    : undefined;

  return {
    modelId: result.model.id,
    label: result.model.label,
    kind: result.model.kind,
    status: result.status,
    ...(result.abortReason !== undefined && { abortReason: result.abortReason }),
    accuracy: {
      overall: mean(played.map((entry) => entry.score.score)),
      single: mean(single.map((entry) => entry.score.score)),
      singleOwn: mean(
        single
          .filter((entry) => entry.run.decisions[0]?.source !== 'bot-handoff')
          .map((entry) => entry.score.score),
      ),
      turn: mean(turn.map((entry) => entry.score.score)),
      casesPlayed: played.length,
      casesExpected: cases.length * trials,
      grades,
      objectivesMet: objectives.filter((objective) => objective.met).length,
      objectivesTotal: objectives.length,
    },
    reliability: {
      decisions: decisions.length,
      firstTryLegal: decisions.filter(
        (decision) =>
          decision.invalid === undefined &&
          decision.source !== 'fallback' &&
          decision.source !== 'model-retry' &&
          decision.source !== 'bot-handoff',
      ).length,
      botAnswered: decisions.filter((decision) => decision.source === 'bot-handoff').length,
      correctiveRetries: decisions.filter((decision) => decision.source === 'model-retry').length,
      fallbacks: decisions.filter((decision) => decision.source === 'fallback').length,
      refused: decisions.filter((decision) => decision.invalid !== undefined).length,
      providerErrors: decisions.filter(
        (decision) => decision.failure?.startsWith('provider error') === true,
      ).length,
      decisionCaps: played.filter((entry) => entry.run.termination === 'decision_cap').length,
      consistency:
        repeated.length === 0
          ? null
          : repeated.filter((keys) => keys.every((key) => key === keys[0])).length /
            repeated.length,
    },
    speed: {
      decisions: asked.length,
      meanMs: mean(latencies),
      p50Ms: percentile(latencies, 0.5),
      p90Ms: percentile(latencies, 0.9),
      maxMs: latencies.length === 0 ? null : Math.max(...latencies),
      meanTurnMs: mean(
        turn.map((entry) =>
          entry.run.decisions.reduce((sum, decision) => sum + decision.latencyMs, 0),
        ),
      ),
      totalDecisionMs: latencies.reduce((sum, value) => sum + value, 0),
    },
    cost: {
      totalUsd,
      source: costSource,
      perDecisionUsd,
      perGameUsd: perDecisionUsd === null ? null : perDecisionUsd * DECISIONS_PER_GAME,
      unpricedDecisions,
      promptTokens,
      responseTokens,
      promptTokensPerDecision: billable.length === 0 ? null : promptTokens / billable.length,
      responseTokensPerDecision: billable.length === 0 ? null : responseTokens / billable.length,
      providerRequests: paid.reduce((sum, decision) => sum + decision.requests, 0),
    },
    ...(strategist !== undefined && { strategist }),
  };
}

function isCandidateWithStrategist(result: ModelResult): boolean {
  const spec = result.model['strategist'] as { kind?: string } | undefined;
  return spec?.kind === 'llm';
}

function strategistMetrics(
  calls: readonly StrategistCall[],
  decisions: readonly DecisionRecord[],
  tacticianUsd: number | null,
): StrategistMetrics {
  const billable = calls.filter((call) => call.requests > 0);
  const known = billable.filter((call) => call.costUsd !== undefined);
  const totalUsd =
    billable.length === 0
      ? 0
      : known.length === 0
        ? null
        : known.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
  const sources = new Set(known.map((call) => call.costSource));
  const source: CostMetrics['source'] =
    billable.length === 0
      ? 'free'
      : known.length === 0
        ? 'unknown'
        : known.length < billable.length
          ? 'partial'
          : sources.size === 1
            ? (sources.values().next().value as 'reported' | 'estimated')
            : 'mixed';
  // Waits are what the seat sat through before a decision; a call no decision waited for has none.
  const waits = calls.filter((call) => call.waitMs > 0).map((call) => call.waitMs);
  return {
    calls: calls.length,
    failures: calls.filter((call) => call.failure !== undefined).length,
    providerErrors: calls.filter((call) => call.failure?.startsWith('provider error') === true)
      .length,
    planSteps: decisions.filter((decision) => decision.source === 'plan').length,
    meanWaitMs: mean(waits),
    p90WaitMs: percentile(waits, 0.9),
    totalUsd,
    source,
    perCallUsd: totalUsd === null || known.length === 0 ? null : totalUsd / known.length,
    promptTokens: calls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0),
    responseTokens: calls.reduce((sum, call) => sum + (call.responseTokens ?? 0), 0),
    providerRequests: calls.reduce((sum, call) => sum + call.requests, 0),
    combinedUsd: totalUsd === null || tacticianUsd === null ? null : totalUsd + tacticianUsd,
  };
}
