/** Null Rod (common blocking lines, PR #89): scenarios in ../../scenarios/null-rod.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/null-rod.json', import.meta.url));

describe('Null Rod', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('null-rod-locks-artifact-ability: the lock removes every activation, which the same position offers without it', () => {
    const scenario = file.scenarios.find(
      (entry) => entry.id === 'null-rod-locks-artifact-ability',
    )!;
    const offered = (target: typeof scenario) =>
      firstDecisionOf(file, target, 'P1')?.legalActions.map((action) => action.description) ?? [];
    const sources = ['Scenario Wand'];
    const locked = offered(scenario);
    for (const source of sources)
      expect(locked.some((text) => text.startsWith(`${source}:`))).toBe(false);
    const p1 = scenario.seats.P1!;
    const unlocked = {
      ...scenario,
      seats: {
        ...scenario.seats,
        P1: { ...p1, battlefield: p1.battlefield!.filter((name) => name !== 'Null Rod') },
      },
    };
    const open = offered(unlocked);
    for (const source of sources)
      expect(open.some((text) => text.startsWith(`${source}:`))).toBe(true);
  });
});
