import { cpus } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assessThreats, ThreatTracker } from './index';
import { developmentCases, fixtureView, permanent, request } from './fixtures';
import { evaluateCases, pairedStrategistTrials } from './evaluate';

describe('threat evaluation tools', () => {
  it('reports baselines, misses, false alarms and abstentions separately', () => {
    const report = evaluateCases(developmentCases(), request);
    expect(report.count).toBe(16);
    expect(report.missedCritical).toBe(0);
    expect(report.falseUrgent).toBe(0);
    expect(report.abstentionRate).toBeGreaterThan(0);
    expect(report.labelStatus).toContain('not-independent-review');
    console.info('THREAT_DEVELOPMENT_REPORT', JSON.stringify({ ...report, rows: undefined }));
  });
  it('pairs three trials with identical settings/request and no changes outside threat payload', async () => {
    const seen: Record<string, unknown>[] = [];
    const rows = await pairedStrategistTrials(
      [{ id: 'a', sourceGroup: 'game-a', request, view: fixtureView() }],
      async (prompt, req) => {
        expect(req).toEqual(request);
        seen.push(JSON.parse(prompt.messages[1]!.content) as Record<string, unknown>);
        return { intent: 'Develop', plannedActions: [] };
      },
    );
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.arm === 'threat')).toHaveLength(3);
    const first = seen[0]!;
    for (const payload of seen) {
      delete payload['threatAssessment'];
      expect(payload).toEqual(first);
    }
  });
  it('measures basic and cache overhead on a declared workload without timing-driven policy', () => {
    const v = fixtureView();
    v.battlefield = Array.from({ length: 80 }, (_, i) =>
      permanent(`p-${i}`, `P${1 + (i % 4)}`, i % 7),
    );
    const tracker = new ThreatTracker();
    for (let i = 0; i < 30; i++) assessThreats(v, request);
    const basic: number[] = [],
      cached: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      assessThreats(v, request);
      basic.push(performance.now() - t);
      tracker.assess(v, request);
      const c = performance.now();
      tracker.assess(v, request);
      cached.push(performance.now() - c);
    }
    const p95 = (values: number[]) =>
      values.sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;
    console.info(
      'THREAT_PERFORMANCE',
      JSON.stringify({
        cpu: cpus()[0]?.model,
        runtime: process.version,
        seats: 4,
        permanents: 80,
        iterations: 200,
        basicP95Ms: p95(basic),
        cachedP95Ms: p95(cached),
        search: 'not-implemented',
      }),
    );
    expect(basic).toHaveLength(200);
  });
});
