/**
 * Flusterstorm (EDHREC coverage plan, Phase 3 staples): its clauses as scenarios in
 * ../scenarios/flusterstorm.json, driven through the production engine. A script that meets a decision it
 * does not expect fails the run, and the run is asserted, so that fails the test on an `expect`.
 */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  runScenario,
  scenarioFailures,
  type ScenarioRun,
} from '../scenario/runner';

const file = loadScenarioFile(new URL('../scenarios/flusterstorm.json', import.meta.url));

describe('Flusterstorm', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    let run: ScenarioRun | undefined;
    expect(() => {
      run = runScenario(file, entry);
    }).not.toThrow();
    expect(scenarioFailures(run!, entry)).toEqual([]);
  });

  it('flusterstorm-c01-no-creature-target — Flusterstorm is offered against an instant, never against a creature spell', () => {
    const offers = (id: string) =>
      runScenario(
        file,
        file.scenarios.find((entry) => entry.id === id)!,
      ).answered.filter(
        ({ request }) =>
          request.decidingPlayer === 'P1' &&
          request.legalActions.some(({ description }) =>
            description.startsWith('Cast Flusterstorm'),
          ),
      ).length;
    expect(offers('flusterstorm-controller-pays')).toBeGreaterThan(0);
    expect(offers('flusterstorm-not-creature-spells')).toBe(0);
  });
});
