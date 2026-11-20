/** Michelangelo, Mutant BFF (evasion and blocking batch): scenarios in ../../scenarios/michelangelo.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/michelangelo.json', import.meta.url));

describe('Michelangelo, Mutant BFF', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
