/**
 * Witch Enchanter // Witch-Blessed Meadow (EDHREC coverage plan, Phase 2 modal DFC with a permanent front face): its clauses as scenarios in
 * ../scenarios/witch-enchanter.json, driven through the production engine. A script that meets a
 * decision it does not expect (an optional prompt that should not be there, or one that is
 * missing) fails the run, and the run is asserted, so that fails the test on an `expect`.
 */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  runScenario,
  scenarioFailures,
  type ScenarioRun,
} from '../scenario/runner';

const file = loadScenarioFile(new URL('../scenarios/witch-enchanter.json', import.meta.url));

describe('Witch Enchanter // Witch-Blessed Meadow', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    let run: ScenarioRun | undefined;
    expect(() => {
      run = runScenario(file, entry);
    }).not.toThrow();
    expect(scenarioFailures(run!, entry)).toEqual([]);
  });
});
