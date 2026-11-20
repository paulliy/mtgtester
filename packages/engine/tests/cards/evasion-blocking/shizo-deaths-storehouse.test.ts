/** Shizo, Death's Storehouse (evasion and blocking batch): scenarios in ../../scenarios/shizo-deaths-storehouse.json. */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  offeredTargetNames,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/shizo-deaths-storehouse.json', import.meta.url),
);

describe("Shizo, Death's Storehouse", () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clause 2, negative: only the legendary creature is a legal target, not a nonlegendary one', () => {
    const scenario = file.scenarios.find(
      (entry) => entry.id === 'shizo-deaths-storehouse-fear-only-legendary-target',
    )!;
    expect(offeredTargetNames(file, scenario, 'P1', '/gains fear/')).toEqual([['Scenario Legend']]);
  });
});
