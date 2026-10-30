/** Takenuma, Abandoned Mire (pilot-new batch): scenarios in ../../scenarios/takenuma-abandoned-mire.json. */
import { describe, expect, it } from 'vitest';
import {
  choiceAfterScript,
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/takenuma-abandoned-mire.json', import.meta.url),
);
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;
/** What P1 is first offered; nothing when P1 is never asked. */
const offered = (id: string): string[] =>
  firstDecisionOf(file, scenario(id), 'P1')?.legalActions.map((action) => action.description) ?? [];

describe('Takenuma, Abandoned Mire', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clause 1: Takenuma alone pays for a {B} spell', () => {
    expect(offered('takenuma-tap-for-black')).toContainEqual(
      expect.stringMatching(/^Cast Scenario Sorcery/),
    );
  });

  it('clause 2: two legendary creatures bring channel down to what two Swamps pay', () => {
    expect(offered('takenuma-legend-discount')).toContainEqual(
      expect.stringMatching(/Discard this card/),
    );
  });

  it('clause 2, negative: without legendary creatures two Swamps do not pay for channel', () => {
    const actions = offered('takenuma-no-discount');
    expect(actions).toContainEqual(expect.stringMatching(/^Cast Scenario Sorcery/));
    expect(actions).not.toContainEqual(expect.stringMatching(/Discard this card/));
  });

  it('clause 2, negative: a card that is not a creature or planeswalker is never offered', () => {
    // Scenario Sorcery and three milled lands are in the graveyard; with nothing that qualifies,
    // nothing is asked. Only the milled creature qualifies in the other: it returns unasked.
    expect(choiceAfterScript(file, scenario('takenuma-nothing-qualifies'))).toBeNull();
    expect(choiceAfterScript(file, scenario('takenuma-mill-then-return-milled'))).toBeNull();
  });
});
