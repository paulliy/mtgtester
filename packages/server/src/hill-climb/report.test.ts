import { describe, expect, it } from 'vitest';
import { compareReports, renderComparison, type Metric, type Report } from './report';

const timed = (value: number, spread = 0): Metric => ({
  value,
  unit: 'ms',
  better: 'lower',
  kind: 'timed',
  spread,
});
const exact = (value: number, better: Metric['better'] = 'lower'): Metric => ({
  value,
  unit: 'calls',
  better,
  kind: 'exact',
});

function report(metrics: Record<string, Metric>, overrides: Partial<Report> = {}): Report {
  return {
    schema: 1,
    profile: 'quick',
    probes: ['engine', 'setup', 'model', 'coverage'],
    commit: 'abc1234',
    dirty: false,
    machine: 'test cpu x4, linux-x64, bun 1.4.3',
    calibrationMs: 100,
    repeats: 3,
    metrics,
    fingerprints: { '0': 'aaaa', '3': 'bbbb' },
    ...overrides,
  };
}

const verdicts = (baseline: Report, current: Report): Record<string, string> =>
  Object.fromEntries(compareReports(baseline, current).rows.map((row) => [row.id, row.verdict]));

describe('compareReports: exact metrics', () => {
  it('fails on any move in the wrong direction and credits any move in the right one', () => {
    const baseline = report({
      'model.bot.callsPerTurn': exact(0.6),
      'model.model.callsPerTurn': exact(3.75),
      'coverage.edhrecModeledCards': exact(3718, 'higher'),
      'coverage.edhrecSlotSharePct': exact(54.9, 'higher'),
    });
    const current = report({
      'model.bot.callsPerTurn': exact(0.601),
      'model.model.callsPerTurn': exact(3.7),
      'coverage.edhrecModeledCards': exact(3717, 'higher'),
      'coverage.edhrecSlotSharePct': exact(55.2, 'higher'),
    });
    const comparison = compareReports(baseline, current);
    expect(verdicts(baseline, current)).toEqual({
      'model.bot.callsPerTurn': 'regressed',
      'model.model.callsPerTurn': 'improved',
      'coverage.edhrecModeledCards': 'regressed',
      'coverage.edhrecSlotSharePct': 'improved',
    });
    expect(comparison.ok).toBe(false);
    expect(comparison.failures).toHaveLength(2);
  });

  it('passes an identical report', () => {
    const same = report({ 'model.bot.callsPerTurn': exact(0.6) });
    const comparison = compareReports(same, same);
    expect(comparison.ok).toBe(true);
    expect(comparison.rows.map((row) => row.verdict)).toEqual(['unchanged']);
    expect(comparison.fingerprints.verdict).toBe('identical');
  });

  it('treats a move off a zero baseline as a full change', () => {
    const baseline = report({ 'coverage.compilerRefusals': exact(0) });
    const current = report({ 'coverage.compilerRefusals': exact(2) });
    expect(verdicts(baseline, current)).toEqual({ 'coverage.compilerRefusals': 'regressed' });
  });
});

describe('compareReports: timed metrics', () => {
  it('ignores a change inside the same-machine floor', () => {
    const baseline = report({ 'engine.msPerDecision': timed(50) });
    expect(verdicts(baseline, report({ 'engine.msPerDecision': timed(54.9) }))).toEqual({
      'engine.msPerDecision': 'unchanged',
    });
    expect(verdicts(baseline, report({ 'engine.msPerDecision': timed(45.1) }))).toEqual({
      'engine.msPerDecision': 'unchanged',
    });
  });

  it('counts a change beyond the floor, in either direction', () => {
    const baseline = report({ 'engine.msPerDecision': timed(50) });
    const slower = compareReports(baseline, report({ 'engine.msPerDecision': timed(56) }));
    expect(slower.rows[0]!.verdict).toBe('regressed');
    expect(slower.ok).toBe(false);
    const faster = compareReports(baseline, report({ 'engine.msPerDecision': timed(40) }));
    expect(faster.rows[0]!.verdict).toBe('improved');
    expect(faster.ok).toBe(true);
  });

  it('needs a 20% move when either side was measured fewer than three times', () => {
    const baseline = report({ 'engine.msPerDecision': timed(50) });
    const once = { repeats: 1 };
    const within = compareReports(baseline, report({ 'engine.msPerDecision': timed(42) }, once));
    expect(within.rows[0]!.threshold).toBe(0.2);
    expect(within.rows[0]!.verdict).toBe('unchanged');
    expect(
      compareReports(baseline, report({ 'engine.msPerDecision': timed(61) }, once)).rows[0]!
        .verdict,
    ).toBe('regressed');
    expect(renderComparison(within)).toContain('--repeat 3');
  });

  it('widens the threshold to twice the larger run-to-run spread', () => {
    // Runs 12% apart on either side: a 20% move is not yet distinguishable from noise.
    const baseline = report({ 'engine.msPerDecision': timed(50, 0.12) });
    const noisy = compareReports(baseline, report({ 'engine.msPerDecision': timed(60, 0.02) }));
    expect(noisy.rows[0]!.threshold).toBeCloseTo(0.24);
    expect(noisy.rows[0]!.verdict).toBe('unchanged');
    const fromCurrent = compareReports(
      report({ 'engine.msPerDecision': timed(50) }),
      report({ 'engine.msPerDecision': timed(40, 0.2) }),
    );
    expect(fromCurrent.rows[0]!.verdict).toBe('unchanged');
    expect(verdicts(baseline, report({ 'engine.msPerDecision': timed(63) }))).toEqual({
      'engine.msPerDecision': 'regressed',
    });
  });

  it('scales timings by the calibration run across machines and uses the wide floor', () => {
    const baseline = report({ 'engine.msPerDecision': timed(50) });
    // A machine half as fast: 100 ms there is 50 ms here.
    const slowMachine = { machine: 'other cpu x2, linux-x64, bun 1.4.3', calibrationMs: 200 };
    const level = compareReports(
      baseline,
      report({ 'engine.msPerDecision': timed(100) }, slowMachine),
    );
    expect(level.sameMachine).toBe(false);
    expect(level.rows[0]!.current).toBeCloseTo(50);
    expect(level.rows[0]!.verdict).toBe('unchanged');
    // 25% slower after scaling is inside the 30% cross-machine floor; 40% is not.
    expect(
      compareReports(baseline, report({ 'engine.msPerDecision': timed(125) }, slowMachine)).rows[0]!
        .verdict,
    ).toBe('unchanged');
    expect(
      compareReports(baseline, report({ 'engine.msPerDecision': timed(140) }, slowMachine)).rows[0]!
        .verdict,
    ).toBe('regressed');
  });

  it('treats the same machine under different load as another machine', () => {
    const baseline = report({ 'engine.msPerDecision': timed(50) });
    const loaded = compareReports(
      baseline,
      report({ 'engine.msPerDecision': timed(60) }, { calibrationMs: 140 }),
    );
    expect(loaded.sameMachine).toBe(false);
    expect(loaded.rows[0]!.verdict).toBe('unchanged');
  });

  it('never scales an exact metric', () => {
    const baseline = report({ 'model.bot.callsPerTurn': exact(0.6) });
    const current = report({ 'model.bot.callsPerTurn': exact(0.6) }, { calibrationMs: 300 });
    expect(compareReports(baseline, current).rows[0]!.current).toBe(0.6);
  });
});

describe('compareReports: metrics present on one side', () => {
  it('fails when a probe that ran lost a baseline metric', () => {
    const baseline = report({
      'model.bot.callsPerTurn': exact(0.6),
      'engine.msPerDecision': timed(50),
    });
    const comparison = compareReports(baseline, report({ 'engine.msPerDecision': timed(50) }));
    expect(comparison.rows.find((row) => row.id === 'model.bot.callsPerTurn')!.verdict).toBe(
      'missing',
    );
    expect(comparison.ok).toBe(false);
  });

  it('skips the metrics of a probe that did not run', () => {
    const baseline = report({
      'model.bot.callsPerTurn': exact(0.6),
      'engine.msPerDecision': timed(50),
    });
    const comparison = compareReports(
      baseline,
      report({ 'model.bot.callsPerTurn': exact(0.6) }, { probes: ['model'], fingerprints: {} }),
    );
    expect(comparison.rows.map((row) => row.id)).toEqual(['model.bot.callsPerTurn']);
    expect(comparison.fingerprints.verdict).toBe('not-compared');
    expect(comparison.ok).toBe(true);
  });

  it('reports a metric the baseline does not have as new, without failing', () => {
    const comparison = compareReports(
      report({}),
      report({ 'coverage.playableDecksPct': exact(40, 'higher') }),
    );
    expect(comparison.rows[0]!.verdict).toBe('new');
    expect(comparison.ok).toBe(true);
  });
});

describe('compareReports: fingerprints', () => {
  const metrics = { 'engine.msPerDecision': timed(50) };

  it('fails when a game played differently, however much faster it ran', () => {
    const comparison = compareReports(
      report(metrics),
      report({ 'engine.msPerDecision': timed(10) }, { fingerprints: { '0': 'aaaa', '3': 'cccc' } }),
    );
    expect(comparison.fingerprints).toEqual({ verdict: 'changed', compared: 2, changed: ['3'] });
    expect(comparison.ok).toBe(false);
    expect(comparison.failures.join('\n')).toContain('seed(s) 3');
  });

  it('fails when a baseline seed was not played, or an extra one was', () => {
    const fewer = compareReports(
      report(metrics),
      report(metrics, { fingerprints: { '0': 'aaaa' } }),
    );
    expect(fewer.fingerprints.changed).toEqual(['3']);
    const more = compareReports(
      report(metrics),
      report(metrics, { fingerprints: { '0': 'aaaa', '3': 'bbbb', '6': 'dddd' } }),
    );
    expect(more.fingerprints.changed).toEqual(['6']);
    expect(more.ok).toBe(false);
  });

  it('lets a declared behaviour change through but still reports it', () => {
    const comparison = compareReports(
      report(metrics),
      report(metrics, { fingerprints: { '0': 'zzzz', '3': 'bbbb' } }),
      { allowBehaviorChange: true },
    );
    expect(comparison.fingerprints.verdict).toBe('changed');
    expect(comparison.ok).toBe(true);
    expect(renderComparison(comparison)).toContain('games: CHANGED on seed(s) 0 of 2');
  });
});

describe('renderComparison', () => {
  it('prints one line per metric with its verdict and the noise it had to beat', () => {
    const text = renderComparison(
      compareReports(
        report({ 'engine.msPerDecision': timed(50), 'model.bot.callsPerTurn': exact(0.6) }),
        report({ 'engine.msPerDecision': timed(30), 'model.bot.callsPerTurn': exact(0.7) }),
      ),
    );
    expect(text).toMatch(/engine\.msPerDecision \(ms\)\s+50\s+30\s+-40\.0%\s+>10%\s+IMPROVED/);
    expect(text).toMatch(
      /model\.bot\.callsPerTurn \(calls\)\s+0\.600\s+0\.700\s+\+16\.7%\s+any\s+REGRESSED/,
    );
    expect(text).toContain('games: all 2 fingerprints identical');
  });
});
