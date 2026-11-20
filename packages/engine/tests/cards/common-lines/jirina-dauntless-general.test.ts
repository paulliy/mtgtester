/** Jirina, Dauntless General (common blocking lines, PR #89): scenarios in ../../scenarios/jirina-dauntless-general.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/jirina-dauntless-general.json', import.meta.url),
);

describe('Jirina, Dauntless General', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
