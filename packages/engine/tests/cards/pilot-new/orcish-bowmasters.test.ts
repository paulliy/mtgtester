/** Orcish Bowmasters (pilot-new batch): scenarios in ../../scenarios/orcish-bowmasters.json. */
import { describe, expect, it } from 'vitest';
import {
  choiceAfterScript,
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/orcish-bowmasters.json', import.meta.url));
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;

describe('Orcish Bowmasters', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clause 1: with flash, it can be cast on an opponent’s turn', () => {
    const flash = scenario('bowmasters-flash');
    const first = firstDecisionOf(file, flash, 'P1');
    expect(first?.legalActions.map((action) => action.description) ?? []).toContainEqual(
      expect.stringMatching(/^Cast Orcish Bowmasters/),
    );
  });

  it('clause 2: the enter trigger takes any target, a player or a creature', () => {
    const enters = scenario('bowmasters-enters-ping');
    const choice = choiceAfterScript(file, { ...enters, script: enters.script.slice(0, 1) });
    const options = choice?.legalActions[0]?.targets?.[0]?.options ?? [];
    expect(options).toEqual(expect.arrayContaining(['P1', 'P2']));
    expect(options.length).toBeGreaterThan(2);
  });

  it('clause 2: nothing is left to answer after each trigger is targeted', () => {
    expect(choiceAfterScript(file, scenario('bowmasters-draws-two'))).toBeNull();
    // Neither trigger is a "you may": once targeted, nothing more is asked.
    expect(choiceAfterScript(file, scenario('bowmasters-enters-ping'))).toBeNull();
  });

  it("clause 2, negative: an opponent's first draw in their draw step asks nothing", () => {
    expect(firstDecisionOf(file, scenario('bowmasters-first-draw-exempt'), 'P1')).toBeNull();
  });

  it('clause 2, negative: your own draw asks nothing after the spell', () => {
    expect(choiceAfterScript(file, scenario('bowmasters-own-draw'))).toBeNull();
  });
});
