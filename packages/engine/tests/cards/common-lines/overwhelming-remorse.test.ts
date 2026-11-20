/** Overwhelming Remorse (common blocking lines, PR #89): scenarios in ../../scenarios/overwhelming-remorse.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/overwhelming-remorse.json', import.meta.url),
);

describe('Overwhelming Remorse', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
