import { describe, expect, it } from 'vitest';
import { DRAKUSETH_WORDING_SCENARIO_IDS } from './drakuseth-wording-scenarios';
import { evaluateDrakusethWordingGameplayAi } from './gameplay-ai-evaluation';

describe('Drakuseth wording gameplay-AI quality evidence', () => {
  it('records random and heuristic runs for each prepared scenario without claiming rules proof', () => {
    const report = evaluateDrakusethWordingGameplayAi();

    expect(report.liveLlm).toBe('not-run');
    expect(report.note).toContain('Quality-only');
    expect(report.runs).toHaveLength(DRAKUSETH_WORDING_SCENARIO_IDS.length * 2);
    expect(new Set(report.runs.map((run) => run.providerKind))).toEqual(
      new Set(['random', 'heuristic']),
    );
    expect(new Set(report.runs.map((run) => run.scenarioId))).toEqual(
      new Set(DRAKUSETH_WORDING_SCENARIO_IDS),
    );

    for (const run of report.runs) {
      expect(run.decisions).toBeGreaterThan(0);
      expect(run.observations.length).toBeGreaterThan(0);
      expect(run.halted).toBe(false);
      expect(run.oracleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(run.scenarioVersion).toBeGreaterThan(0);
    }
  });
});
