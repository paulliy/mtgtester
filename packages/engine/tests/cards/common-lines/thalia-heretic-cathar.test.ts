/** Thalia, Heretic Cathar (common blocking lines, PR #89): scenarios in ../../scenarios/thalia-heretic-cathar.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/thalia-heretic-cathar.json', import.meta.url),
);

describe('Thalia, Heretic Cathar', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
