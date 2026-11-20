/** Rampaging Ceratops (evasion and blocking batch): scenarios in ../../scenarios/rampaging-ceratops.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/rampaging-ceratops.json', import.meta.url));

describe('Rampaging Ceratops', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
