/** Sliver Hive (graveyard and hand batch): scenarios in ../../scenarios/sliver-hive.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/sliver-hive.json', import.meta.url));

describe('Sliver Hive', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('the token ability is offered only while you control a Sliver', () => {
    const offered = (id: string) =>
      (firstDecisionOf(file, scenario(id), 'P1')?.legalActions ?? []).some((action) =>
        action.description.includes('Create'),
      );
    expect(offered('sliver-hive-token')).toBe(true);
    expect(offered('sliver-hive-no-sliver')).toBe(false);
  });
});
