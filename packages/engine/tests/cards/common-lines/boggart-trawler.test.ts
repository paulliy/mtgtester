/** Boggart Trawler // Boggart Bog (common blocking lines, PR #89): scenarios in ../../scenarios/boggart-trawler.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/boggart-trawler.json', import.meta.url));

describe('Boggart Trawler // Boggart Bog', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
