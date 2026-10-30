/** Mox Diamond (pilot-new batch): scenarios in ../../scenarios/mox-diamond.json. */
import { describe, expect, it } from 'vitest';
import {
  choiceAfterScript,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/mox-diamond.json', import.meta.url));
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;

describe('Mox Diamond', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clause 1: the choice offers each land card in hand and discarding nothing, and no other card', () => {
    const choose = scenario('mox-diamond-choose-land');
    const choice = choiceAfterScript(file, { ...choose, script: choose.script.slice(0, 1) });
    expect(choice?.legalActions.map((action) => action.description)).toEqual([
      'Discard Forest',
      'Discard Island',
      "Discard nothing: put Mox Diamond into its owner's graveyard",
    ]);
  });

  it('clause 2: once it is on the battlefield its mana pays for a red spell', () => {
    const land = scenario('mox-diamond-discard-land');
    const run = runScenario(file, { ...land, script: land.script.slice(0, 2) });
    expect(run.stoppedAt?.legalActions.map((action) => action.description) ?? []).toContainEqual(
      expect.stringMatching(/^Cast Scenario Imp/),
    );
  });

  it('clause 1, negative: with no land card in hand nothing is asked and it goes to the graveyard', () => {
    expect(choiceAfterScript(file, scenario('mox-diamond-no-land'))).toBeNull();
  });
});
