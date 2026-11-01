/** Mizzium Mortars (mini-pilot batch): scenarios in ../../scenarios/mizzium-mortars.json. */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  offeredTargetNames,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/mizzium-mortars.json', import.meta.url));
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;

describe('Mizzium Mortars', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it("clause 1, negative: only creatures you don't control are offered, and not a hexproof one", () => {
    const overload = scenario('mizzium-mortars-overload');
    expect(
      offeredTargetNames(file, overload, 'P1', '/^Cast Mizzium Mortars \\(\\{1\\}\\{R\\}\\)/'),
    ).toEqual([['Scenario Bear', 'Scenario Ox']]);
  });
});
