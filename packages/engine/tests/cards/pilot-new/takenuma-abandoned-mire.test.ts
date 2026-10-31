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

  it('clause 2: three legendary creatures bring channel down to {B}, which one Swamp pays', () => {
    expect(offered('takenuma-three-legends-one-swamp')).toContainEqual(
      expect.stringMatching(/Discard this card/),
    );
  });

  it('clause 2, negative: one legendary creature takes off only {1}, so two Swamps do not pay', () => {
    // Channel would cost {2}{B}. Scenario Sorcery shows P1 is being asked with a Swamp to spend.
    const actions = offered('takenuma-one-legend-not-enough');
    expect(actions).toContainEqual(expect.stringMatching(/^Cast Scenario Sorcery/));
    expect(actions).not.toContainEqual(expect.stringMatching(/Discard this card/));
  });

  it('clause 2, negative: the discount is generic only, so no black mana cannot channel', () => {
    // Three legendary creatures cover all of {3}, and the Forest is no help with {B}.
    const actions = offered('takenuma-three-legends-no-black');
    expect(actions).toContainEqual(expect.stringMatching(/^Play Island/));
    expect(actions).not.toContainEqual(expect.stringMatching(/Discard this card/));
  });

  it('clause 2, negative: a card that is not a creature or planeswalker is never offered', () => {
    // Scenario Sorcery and three milled lands are in the graveyard; with nothing that qualifies,
    // nothing is asked. Only the milled creature qualifies in the other: it returns unasked.
    expect(choiceAfterScript(file, scenario('takenuma-nothing-qualifies'))).toBeNull();
    expect(choiceAfterScript(file, scenario('takenuma-mill-then-return-milled'))).toBeNull();
  });
});
