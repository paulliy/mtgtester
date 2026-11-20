/** Blightsteel Colossus (graveyard and hand batch): scenarios in ../../scenarios/blightsteel-colossus.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/blightsteel-colossus.json', import.meta.url),
);

describe('Blightsteel Colossus', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
