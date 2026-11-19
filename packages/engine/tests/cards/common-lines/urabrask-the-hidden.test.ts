/** Urabrask the Hidden (common blocking lines, PR #89): scenarios in ../../scenarios/urabrask-the-hidden.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/urabrask-the-hidden.json', import.meta.url));

describe('Urabrask the Hidden', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
