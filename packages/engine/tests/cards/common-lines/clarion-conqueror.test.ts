/** Clarion Conqueror (common blocking lines, PR #89): scenarios in ../../scenarios/clarion-conqueror.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/clarion-conqueror.json', import.meta.url));

describe('Clarion Conqueror', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clarion-conqueror-locks-artifact-creature-planeswalker: the lock removes every activation, which the same position offers without it', () => {
    const scenario = file.scenarios.find(
      (entry) => entry.id === 'clarion-conqueror-locks-artifact-creature-planeswalker',
    )!;
    const offered = (target: typeof scenario) =>
      firstDecisionOf(file, target, 'P1')?.legalActions.map((action) => action.description) ?? [];
    const sources = ['Scenario Wand', 'Scenario Squire', 'Scenario Walker'];
    const locked = offered(scenario);
    for (const source of sources)
      expect(locked.some((text) => text.startsWith(`${source}:`))).toBe(false);
    const p1 = scenario.seats.P1!;
    const unlocked = {
      ...scenario,
      seats: {
        ...scenario.seats,
        P1: { ...p1, battlefield: p1.battlefield!.filter((name) => name !== 'Clarion Conqueror') },
      },
    };
    const open = offered(unlocked);
    for (const source of sources)
      expect(open.some((text) => text.startsWith(`${source}:`))).toBe(true);
  });
});
