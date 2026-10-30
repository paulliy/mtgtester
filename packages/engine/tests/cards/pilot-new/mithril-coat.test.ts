/** Mithril Coat (pilot-new batch): scenarios in ../../scenarios/mithril-coat.json. */
import { describe, expect, it } from 'vitest';
import {
  choiceAfterScript,
  firstDecisionOf,
  loadScenarioFile,
  offeredTargetNames,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/mithril-coat.json', import.meta.url));
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;

describe('Mithril Coat', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clause 3: the enter trigger asks nothing when one legendary creature of yours is its only target', () => {
    // Scenario Bear is yours but not legendary: were it a legal target, the trigger would ask.
    expect(choiceAfterScript(file, scenario('mithril-coat-attach-on-enter'))).toBeNull();
  });

  it("clause 1: with flash, you may cast it when you get priority on an opponent's turn", () => {
    const first = firstDecisionOf(file, scenario('mithril-coat-flash'), 'P1');
    expect(first?.turn).toBe(4);
    expect(first?.legalActions.map((action) => action.description)).toContainEqual(
      expect.stringMatching(/^Cast Mithril Coat/),
    );
  });

  it("clause 5, negative: equip targets only a creature you control, not an opponent's", () => {
    expect(offeredTargetNames(file, scenario('mithril-coat-equip'), 'P1', '/Equip/')).toEqual([
      ['Scenario Bear'],
    ]);
  });

  it("clause 3, negative: your nonlegendary creature and an opponent's legendary one are not targets", () => {
    expect(choiceAfterScript(file, scenario('mithril-coat-no-legendary-host'))).toBeNull();
  });
});
