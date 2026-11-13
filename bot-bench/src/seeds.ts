/**
 * The seed gate (ADR 0043 decision 3.1). A lineup's `seeds` list plays each heuristic and
 * `bot-led` entry once per seed; this folds those runs back together by the entry they came from
 * and reports every case's mean score across seeds. A candidate passes against a baseline when it
 * raises the overall score and lowers no case's mean, partial-credit cases included.
 */
import type { ModelResult } from './run';

export interface SeededEntry {
  /** The lineup entry the seeds were expanded from (or the entry itself, unseeded). */
  id: string;
  label: string;
  /** Seed labels in the order their runs were found. */
  seeds: string[];
  /** Mean score per case, over every seed and trial. */
  caseMeans: Record<string, number>;
  /** Scores behind each case mean: a stopped seed leaves fewer. */
  caseRuns: Record<string, number>;
  /** Seeds whose run stopped before the end (spend cap, provider failures). */
  aborted: string[];
  /** Mean of the case means. */
  overall: number;
  /** Escalated decisions per case, summed over seeds and trials, when any decision was bot-led. */
  escalated?: Record<string, number>;
}

/** A seeded entry's label without its seed: "(seed 3)" on a custom label, ", seed x" on a default. */
export function baseLabel(label: string): string {
  return label.replace(/ \(seed \d+\)$/, '').replace(/, seed [^,)]*\)$/, ')');
}

/** Group a run's results by the entry they were expanded from. */
export function foldSeeds(models: readonly ModelResult[]): SeededEntry[] {
  const groups = new Map<string, ModelResult[]>();
  for (const model of models) {
    const base = typeof model.model['seedOf'] === 'string' ? model.model['seedOf'] : model.model.id;
    groups.set(base, [...(groups.get(base) ?? []), model]);
  }
  return [...groups.entries()].map(([id, results]) => {
    const scores = new Map<string, number[]>();
    const escalated: Record<string, number> = {};
    let botLed = false;
    for (const result of results)
      for (const entry of result.cases) {
        scores.set(entry.caseId, [...(scores.get(entry.caseId) ?? []), entry.score.score]);
        if (entry.run.escalations !== undefined) {
          botLed = true;
          escalated[entry.caseId] =
            (escalated[entry.caseId] ?? 0) + entry.run.escalations.escalated;
        }
      }
    const caseMeans = Object.fromEntries(
      [...scores.entries()].map(([caseId, values]) => [caseId, mean(values)]),
    );
    const first = results[0]!;
    return {
      id,
      label: baseLabel(String(first.model.label)),
      caseRuns: Object.fromEntries([...scores.entries()].map(([caseId, v]) => [caseId, v.length])),
      aborted: results
        .filter((result) => result.status === 'aborted')
        .map((result) =>
          typeof result.model['seed'] === 'string' ? result.model['seed'] : result.model.id,
        ),
      seeds: results.map((result) =>
        typeof result.model['seed'] === 'string' ? result.model['seed'] : '(default)',
      ),
      caseMeans,
      overall: mean(Object.values(caseMeans)),
      ...(botLed && { escalated }),
    };
  });
}

export interface GateResult {
  pass: boolean;
  overallDelta: number;
  /** Cases whose mean fell, with both means. */
  regressions: Array<{ caseId: string; baseline: number; candidate: number }>;
  improvements: Array<{ caseId: string; baseline: number; candidate: number }>;
  /** Cases one side played and the other did not: the comparison is refused. */
  missing: string[];
  problems: string[];
}

/** Floating-point slack for "did not lower": means of the same scores may differ in the last bit. */
const EPSILON = 1e-9;

export function seedGate(baseline: SeededEntry, candidate: SeededEntry): GateResult {
  const problems: string[] = [];
  if (baseline.seeds.join('\n') !== candidate.seeds.join('\n'))
    problems.push('the two entries were not played on the same seeds');
  const cases = new Set([...Object.keys(baseline.caseMeans), ...Object.keys(candidate.caseMeans)]);
  const missing = [...cases].filter(
    (caseId) =>
      baseline.caseMeans[caseId] === undefined || candidate.caseMeans[caseId] === undefined,
  );
  if (missing.length > 0) problems.push(`cases played by only one entry: ${missing.join(', ')}`);
  for (const [entry, side] of [
    [baseline, 'baseline'],
    [candidate, 'candidate'],
  ] as const)
    if (entry.aborted.length > 0)
      problems.push(`${side} stopped early on seed(s) ${entry.aborted.join(', ')}`);
  const uneven = [...cases].filter(
    (caseId) =>
      baseline.caseRuns[caseId] !== undefined &&
      candidate.caseRuns[caseId] !== undefined &&
      baseline.caseRuns[caseId] !== candidate.caseRuns[caseId],
  );
  if (uneven.length > 0)
    problems.push(`cases with a different number of runs per side: ${uneven.join(', ')}`);
  const regressions: GateResult['regressions'] = [];
  const improvements: GateResult['improvements'] = [];
  for (const caseId of [...cases].sort()) {
    const before = baseline.caseMeans[caseId];
    const after = candidate.caseMeans[caseId];
    if (before === undefined || after === undefined) continue;
    if (after < before - EPSILON) regressions.push({ caseId, baseline: before, candidate: after });
    else if (after > before + EPSILON)
      improvements.push({ caseId, baseline: before, candidate: after });
  }
  const overallDelta = candidate.overall - baseline.overall;
  return {
    pass: problems.length === 0 && regressions.length === 0 && overallDelta > EPSILON,
    overallDelta,
    regressions,
    improvements,
    missing,
    problems,
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
