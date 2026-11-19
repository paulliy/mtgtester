/** Spectral Denial (common blocking lines, PR #89): scenarios in ../../scenarios/spectral-denial.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/spectral-denial.json', import.meta.url));

describe('Spectral Denial', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
