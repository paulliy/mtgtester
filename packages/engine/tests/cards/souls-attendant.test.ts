/**
 * Soul's Attendant (EDHREC coverage plan, Phase 4 grammar breadth): its clauses as scenarios in
 * ../scenarios/souls-attendant.json, driven through the production engine. A script that meets a decision it
 * does not expect fails the run, and the run is asserted, so that fails the test on an `expect`.
 */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  runScenario,
  scenarioFailures,
  type ScenarioRun,
} from '../scenario/runner';

const file = loadScenarioFile(new URL('../scenarios/souls-attendant.json', import.meta.url));

describe("Soul's Attendant", () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    let run: ScenarioRun | undefined;
    expect(() => {
      run = runScenario(file, entry);
    }).not.toThrow();
    expect(scenarioFailures(run!, entry)).toEqual([]);
  });
});
