/** Simian Spirit Guide (graveyard and hand batch): scenarios in ../../scenarios/simian-spirit-guide.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/simian-spirit-guide.json', import.meta.url));

describe('Simian Spirit Guide', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
