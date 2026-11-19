/** Kinjalli's Sunwing (common blocking lines, PR #89): scenarios in ../../scenarios/kinjallis-sunwing.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/kinjallis-sunwing.json', import.meta.url));

describe("Kinjalli's Sunwing", () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
