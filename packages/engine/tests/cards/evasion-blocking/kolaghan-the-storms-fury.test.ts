/** Kolaghan, the Storm's Fury (evasion-and-blocking batch): scenarios in ../../scenarios/kolaghan-the-storms-fury.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/kolaghan-the-storms-fury.json', import.meta.url),
);

describe("Kolaghan, the Storm's Fury", () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
