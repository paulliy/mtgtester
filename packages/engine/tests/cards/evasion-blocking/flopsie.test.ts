/** Flopsie, Bumi's Buddy (evasion and blocking batch): scenarios in ../../scenarios/flopsie.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/flopsie.json', import.meta.url));

describe("Flopsie, Bumi's Buddy", () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
