/**
 * The hill-climb report and how two reports compare (see docs/guides/hill-climbing.md).
 *
 * A report is one measurement of the project's cost metrics on one commit and one machine. Exact
 * metrics (model calls, tokens, card counts) are the same on every machine, so any move in the
 * wrong direction is a regression. Timed metrics vary from run to run and from machine to machine,
 * so they only count as changed when they move by more than the noise seen in the two reports.
 * Fingerprints say whether the benchmark games played out the same, decision by decision.
 */

export type Better = 'lower' | 'higher';

export interface Metric {
  value: number;
  unit: string;
  better: Better;
  /** `exact` repeats to the last digit on any machine; `timed` is a wall-clock measurement. */
  kind: 'exact' | 'timed';
  /** Timed only: (slowest - fastest) / fastest over the repeats, 0 when measured once. */
  spread?: number;
}

export interface Report {
  schema: 1;
  profile: string;
  /** The probes that ran: a metric the baseline has under one of them must be present here. */
  probes: string[];
  commit: string;
  /** True when the working tree had uncommitted changes. */
  dirty: boolean;
  /** CPU model, core count, platform and Bun version. */
  machine: string;
  /** Time for the fixed calibration workload, used to scale timings between machines. */
  calibrationMs: number;
  repeats: number;
  metrics: Record<string, Metric>;
  /** Engine benchmark game fingerprints by seed. */
  fingerprints: Record<string, string>;
}

/** The committed baseline: one report per profile. */
export interface Baseline {
  schema: 1;
  profiles: Record<string, Report>;
}

export type Verdict = 'improved' | 'unchanged' | 'regressed' | 'missing' | 'new';

export interface MetricRow {
  id: string;
  unit: string;
  kind: Metric['kind'];
  baseline: number | null;
  /** The current value; a timed value from another machine is scaled to the baseline's machine. */
  current: number | null;
  /** Relative change, positive when the value went up. Null when either side is missing. */
  change: number | null;
  /** The relative change that counts as real for this row. 0 for exact metrics. */
  threshold: number;
  verdict: Verdict;
}

export type FingerprintVerdict = 'identical' | 'changed' | 'not-compared';

export interface Comparison {
  rows: MetricRow[];
  sameMachine: boolean;
  /** Both sides were measured at least three times, so the narrow noise floor applied. */
  repeated: boolean;
  fingerprints: {
    verdict: FingerprintVerdict;
    compared: number;
    /** Seeds whose games differ, or that one side did not play. */
    changed: string[];
  };
  /** False when a metric regressed or went missing, or games changed without being allowed to. */
  ok: boolean;
  failures: string[];
}

export interface CompareOptions {
  /** The games are meant to change (a rules, bot or card change), so do not fail on fingerprints. */
  allowBehaviorChange?: boolean;
}

/** Smallest timed change that counts on one machine when both sides were repeated. */
export const SAME_MACHINE_FLOOR = 0.1;
/** With fewer repeats on either side the spread is unknown, so the floor is wider. */
export const UNREPEATED_FLOOR = 0.2;
/** Repeats each side needs before the narrow floor applies. */
export const REPEATS_FOR_NARROW_FLOOR = 3;
/** Across machines the calibration scaling is rough, so only a large move counts. */
export const CROSS_MACHINE_FLOOR = 0.3;
/** A timed change must exceed this many times the larger run-to-run spread. */
export const SPREAD_FACTOR = 2;
/** Calibration runs on one machine agree to within this. */
const CALIBRATION_DRIFT = 0.25;

const EPSILON = 1e-9;

export function sameMachine(baseline: Report, current: Report): boolean {
  if (baseline.machine !== current.machine) return false;
  const ratio = current.calibrationMs / baseline.calibrationMs;
  return Number.isFinite(ratio) && Math.abs(ratio - 1) <= CALIBRATION_DRIFT;
}

/** The probe a metric id belongs to: the part before the first dot. */
const probeOf = (id: string): string => id.split('.')[0]!;

function verdictFor(change: number, threshold: number, better: Better): Verdict {
  if (Math.abs(change) <= threshold + EPSILON) return 'unchanged';
  const wentDown = change < 0;
  return wentDown === (better === 'lower') ? 'improved' : 'regressed';
}

export function compareReports(
  baseline: Report,
  current: Report,
  options: CompareOptions = {},
): Comparison {
  const same = sameMachine(baseline, current);
  // A slower machine has a larger calibration time, so its timings scale down by the same ratio.
  const scale = same ? 1 : baseline.calibrationMs / current.calibrationMs;
  const ran = new Set(current.probes);
  const repeated =
    baseline.repeats >= REPEATS_FOR_NARROW_FLOOR && current.repeats >= REPEATS_FOR_NARROW_FLOOR;
  const floor = !same ? CROSS_MACHINE_FLOOR : repeated ? SAME_MACHINE_FLOOR : UNREPEATED_FLOOR;
  const rows: MetricRow[] = [];
  const failures: string[] = [];
  const ids = new Set([...Object.keys(baseline.metrics), ...Object.keys(current.metrics)]);
  for (const id of [...ids].sort()) {
    const before = baseline.metrics[id];
    const after = current.metrics[id];
    if (after === undefined) {
      // Not measured this run (`--only`): nothing to say. Measured but absent: the metric was lost.
      if (!ran.has(probeOf(id)) || before === undefined) continue;
      rows.push({
        id,
        unit: before.unit,
        kind: before.kind,
        baseline: before.value,
        current: null,
        change: null,
        threshold: 0,
        verdict: 'missing',
      });
      failures.push(`${id} is in the baseline but was not reported`);
      continue;
    }
    if (before === undefined) {
      rows.push({
        id,
        unit: after.unit,
        kind: after.kind,
        baseline: null,
        current: after.value,
        change: null,
        threshold: 0,
        verdict: 'new',
      });
      continue;
    }
    const timed = after.kind === 'timed';
    const value = timed ? after.value * scale : after.value;
    const threshold = timed
      ? Math.max(floor, SPREAD_FACTOR * Math.max(before.spread ?? 0, after.spread ?? 0))
      : 0;
    // A zero baseline has no relative change: any move from it is a full-size one.
    const change =
      before.value === 0
        ? value === 0
          ? 0
          : Math.sign(value) * Infinity
        : (value - before.value) / Math.abs(before.value);
    const verdict = verdictFor(change, threshold, after.better);
    rows.push({
      id,
      unit: after.unit,
      kind: after.kind,
      baseline: before.value,
      current: value,
      change,
      threshold,
      verdict,
    });
    if (verdict === 'regressed')
      failures.push(
        `${id} regressed: ${before.value} -> ${Number(value.toFixed(4))} ${after.unit}` +
          (timed ? ` (more than the ${(threshold * 100).toFixed(0)}% noise threshold)` : ''),
      );
  }

  const fingerprints = compareFingerprints(baseline, current, ran.has('engine'));
  if (fingerprints.verdict === 'changed' && options.allowBehaviorChange !== true)
    failures.push(
      `games changed on seed(s) ${fingerprints.changed.join(', ')}: a performance change must ` +
        'leave every fingerprint identical',
    );
  return { rows, sameMachine: same, repeated, fingerprints, ok: failures.length === 0, failures };
}

function compareFingerprints(
  baseline: Report,
  current: Report,
  engineRan: boolean,
): Comparison['fingerprints'] {
  const seeds = Object.keys(baseline.fingerprints);
  if (!engineRan || seeds.length === 0)
    return { verdict: 'not-compared', compared: 0, changed: [] };
  const all = new Set([...seeds, ...Object.keys(current.fingerprints)]);
  const changed = [...all]
    .filter((seed) => baseline.fingerprints[seed] !== current.fingerprints[seed])
    .sort((a, b) => Number(a) - Number(b));
  return {
    verdict: changed.length === 0 ? 'identical' : 'changed',
    compared: all.size,
    changed,
  };
}

const formatValue = (value: number | null): string =>
  value === null
    ? '-'
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(Math.abs(value) < 10 ? 3 : 1);

const formatChange = (change: number | null): string =>
  change === null
    ? '-'
    : !Number.isFinite(change)
      ? 'from 0'
      : `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;

/** The comparison as a plain-text table, one metric per line, then the fingerprint line. */
export function renderComparison(comparison: Comparison): string {
  const header = ['metric', 'baseline', 'current', 'change', 'needs', 'verdict'];
  const body = comparison.rows.map((row) => [
    `${row.id} (${row.unit})`,
    formatValue(row.baseline),
    formatValue(row.current),
    formatChange(row.change),
    row.kind === 'timed' ? `>${(row.threshold * 100).toFixed(0)}%` : 'any',
    row.verdict.toUpperCase(),
  ]);
  const widths = header.map((_, column) =>
    Math.max(...[header, ...body].map((line) => line[column]!.length)),
  );
  const lines = [header, ...body].map((line) =>
    line.map((cell, column) => cell.padEnd(widths[column]!)).join('  '),
  );
  const { fingerprints } = comparison;
  lines.push(
    fingerprints.verdict === 'not-compared'
      ? 'games: not compared (the engine probe did not run, or the baseline has no fingerprints)'
      : fingerprints.verdict === 'identical'
        ? `games: all ${fingerprints.compared} fingerprints identical`
        : `games: CHANGED on seed(s) ${fingerprints.changed.join(', ')} of ${fingerprints.compared}`,
  );
  if (comparison.sameMachine && !comparison.repeated)
    lines.push('timings: for a tighter verdict, measure both sides with --repeat 3');
  if (!comparison.sameMachine)
    lines.push(
      'timings: the baseline came from another machine, so they are scaled by the calibration ' +
        `run and only a move over ${(CROSS_MACHINE_FLOOR * 100).toFixed(0)}% counts`,
    );
  return lines.join('\n');
}
