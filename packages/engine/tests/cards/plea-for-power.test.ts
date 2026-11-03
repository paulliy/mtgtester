/**
 * Plea for Power (EDHREC coverage plan, Phase 2 voting): its clauses as scenarios in
 * ../scenarios/plea-for-power.json, driven through the production engine. A script that meets a decision it
 * does not expect fails the run, and the run is asserted, so that fails the test on an `expect`.
 */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  runScenario,
  scenarioFailures,
  type ScenarioRun,
} from '../scenario/runner';

const file = loadScenarioFile(new URL('../scenarios/plea-for-power.json', import.meta.url));

describe('Plea for Power', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    let run: ScenarioRun | undefined;
    expect(() => {
      run = runScenario(file, entry);
    }).not.toThrow();
    expect(scenarioFailures(run!, entry)).toEqual([]);
  });

  it('plea-votes-in-turn-order — each player votes once, starting with you (CR 701.38a)', () => {
    const run = runScenario(
      file,
      file.scenarios.find(({ id }) => id === 'plea-tie-draws')!,
    );
    const votes = run.engine
      .getState()
      .eventLog.slice(run.firstSequence)
      .filter((event) => event.type === 'vote')
      .map((event) => (event.payload as { player: string; choice: string }).player);
    expect(votes).toEqual(['P1', 'P2', 'P3', 'P4']);
  });
});
