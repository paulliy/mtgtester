/** Stormkeld Vanguard // Bear Down: scenarios in ../../scenarios/stormkeld-vanguard.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/stormkeld-vanguard.json', import.meta.url));

describe('Stormkeld Vanguard // Bear Down', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
