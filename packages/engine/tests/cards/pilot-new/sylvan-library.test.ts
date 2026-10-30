/** Sylvan Library (pilot-new batch): scenarios in ../../scenarios/sylvan-library.json. */
import { describe, expect, it } from 'vitest';
import {
  choiceAfterScript,
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/sylvan-library.json', import.meta.url));
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;

describe('Sylvan Library', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clause 1: only the cards drawn this turn are offered, not one already in hand', () => {
    const old = scenario('sylvan-library-old-card-kept');
    const choice = choiceAfterScript(file, { ...old, script: old.script.slice(0, 1) });
    expect(choice?.legalActions.map((action) => action.description) ?? []).toEqual([
      'Choose Scenario Ant',
      'Choose Scenario Bear',
      'Choose Scenario Cat',
    ]);
  });

  it('clause 1: it asks whether to draw, as the trigger resolves after the draw for the turn', () => {
    const both = scenario('sylvan-library-keep-both');
    const choice = choiceAfterScript(file, { ...both, script: [] });
    expect(choice?.legalActions.map((action) => action.description) ?? []).toEqual(['Yes', 'No']);
  });

  it('clause 1: two cards are chosen, then each costs exactly 4 life to keep', () => {
    const both = scenario('sylvan-library-keep-both');
    const second = choiceAfterScript(file, { ...both, script: both.script.slice(0, 2) });
    expect(second?.legalActions.map((action) => action.description) ?? []).toEqual([
      'Choose Scenario Ant',
      'Choose Scenario Cat',
    ]);
    const pay = choiceAfterScript(file, { ...both, script: both.script.slice(0, 3) });
    expect(pay?.legalActions.map((action) => action.description) ?? []).toEqual([
      'Pay 4 life: keep Scenario Bear',
      'Put Scenario Bear on top of your library',
    ]);
    // Only the two chosen cards are asked about: nothing is left once both are paid for.
    expect(choiceAfterScript(file, both)).toBeNull();
  });

  it('clause 1: at 3 life there is no pay option after the choice', () => {
    const low = scenario('sylvan-library-low-life');
    expect(choiceAfterScript(file, low)).toBeNull();
  });

  it("clause 1, negative: an opponent's draw step asks nothing of its controller", () => {
    expect(firstDecisionOf(file, scenario('sylvan-library-opponent-draw-step'), 'P1')).toBeNull();
  });
});
