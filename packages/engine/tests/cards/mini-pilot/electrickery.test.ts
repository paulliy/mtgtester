/** Electrickery (mini-pilot batch): scenarios in ../../scenarios/electrickery.json. */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  offeredTargetNames,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/electrickery.json', import.meta.url));

describe('Electrickery', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clause 1, negative: your own Squirrel is not offered as a target', () => {
    const overload = file.scenarios.find((entry) => entry.id === 'electrickery-overload')!;
    expect(offeredTargetNames(file, overload, 'P1', '/^Cast Electrickery \\(\\{R\\}\\)/')).toEqual([
      ['Scenario Squirrel', 'Scenario Bear', 'Scenario Squirrel'],
    ]);
  });
});
