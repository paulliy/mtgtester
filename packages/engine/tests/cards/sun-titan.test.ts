/**
 * Sun Titan (EDHREC coverage plan, Phase 3 staples): its clauses as scenarios in
 * ../scenarios/sun-titan.json, driven through the production engine. A script that meets a decision it
 * does not expect fails the run, and the run is asserted, so that fails the test on an `expect`.
 */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  runScenario,
  scenarioFailures,
  type ScenarioRun,
} from '../scenario/runner';

const file = loadScenarioFile(new URL('../scenarios/sun-titan.json', import.meta.url));

describe('Sun Titan', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    let run: ScenarioRun | undefined;
    expect(() => {
      run = runScenario(file, entry);
    }).not.toThrow();
    expect(scenarioFailures(run!, entry)).toEqual([]);
  });

  it('sun-titan-c02-candidates — only permanent cards with mana value 3 or less are offered', () => {
    const entry = file.scenarios.find(({ id }) => id === 'sun-titan-enters-returns')!;
    const run = runScenario(file, entry);
    const offer = run.answered.find(({ request }) =>
      request.legalActions.some(({ description }) =>
        description.startsWith('Targets for Sun Titan'),
      ),
    )!;
    const options = offer.request.legalActions[0]!.targets![0]!.options;
    const graveyard = run.engine.getState().players.find(({ id }) => id === 'P1')!.graveyard;
    const idOf = (name: string) => graveyard.find((card) => card.name === name)!.id;
    expect(options).toHaveLength(2);
    expect(options).toContain(idOf('Scenario Rock'));
    expect(options).not.toContain(idOf('Scenario Ogre'));
    expect(options).not.toContain(idOf('Scenario Bolt'));
  });
});
