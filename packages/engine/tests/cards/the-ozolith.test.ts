/**
 * The Ozolith (EDHREC coverage plan, Phase 2 last-known counters): its two clauses as scenarios in
 * ../scenarios/the-ozolith.json, driven through the production engine. A script that meets a
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

const file = loadScenarioFile(new URL('../scenarios/the-ozolith.json', import.meta.url));

describe('The Ozolith', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    let run: ScenarioRun | undefined;
    expect(() => {
      run = runScenario(file, entry);
    }).not.toThrow();
    expect(scenarioFailures(run!, entry)).toEqual([]);
  });
});
