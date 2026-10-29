/** Ettercap // Web Shot (mini-pilot batch): scenarios in ../../scenarios/ettercap.json. */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  offeredTargetNames,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/ettercap.json', import.meta.url));

describe('Ettercap // Web Shot', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('Web Shot, negative: a creature without flying is not offered as a target', () => {
    expect(offeredTargetNames(file, file.scenarios[0]!, 'P1', '/^Cast Web Shot/')).toEqual([
      ['Scenario Bird'],
    ]);
  });
});
