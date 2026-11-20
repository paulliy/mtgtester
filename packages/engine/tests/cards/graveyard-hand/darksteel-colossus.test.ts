/** Darksteel Colossus (graveyard and hand batch): scenarios in ../../scenarios/darksteel-colossus.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/darksteel-colossus.json', import.meta.url));

describe('Darksteel Colossus', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
