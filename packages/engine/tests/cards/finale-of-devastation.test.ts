/**
 * Finale of Devastation (EDHREC coverage plan, Phase 3 staples): its clauses as scenarios in
 * ../scenarios/finale-of-devastation.json, driven through the production engine. A script that meets a decision it
 * does not expect fails the run, and the run is asserted, so that fails the test on an `expect`.
 */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  runScenario,
  scenarioFailures,
  type ScenarioRun,
} from '../scenario/runner';

const file = loadScenarioFile(new URL('../scenarios/finale-of-devastation.json', import.meta.url));

describe('Finale of Devastation', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    let run: ScenarioRun | undefined;
    expect(() => {
      run = runScenario(file, entry);
    }).not.toThrow();
    expect(scenarioFailures(run!, entry)).toEqual([]);
  });

  it('finale-c01-mana-value-bound — only creature cards with mana value X or less are offered', () => {
    const run = runScenario(
      file,
      file.scenarios.find(({ id }) => id === 'finale-from-library')!,
    );
    const pick = run.answered.find(({ request }) =>
      request.legalActions.some(({ description }) => description === 'Find nothing'),
    )!;
    expect(pick.request.legalActions.map(({ description }) => description)).toEqual([
      'Put Scenario Bear onto the battlefield (from your library)',
      'Find nothing',
    ]);
  });
});
