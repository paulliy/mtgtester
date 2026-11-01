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

  it('clause 2: an opponent’s second draw in its own draw step triggers it', () => {
    const run = runScenario(file, scenario('bowmasters-second-draw-in-draw-step'));
    const [cast, target] = run.answered.filter((entry) => entry.step !== null);
    // P2 casts in its own draw step, after the exempt turn-based draw, and one trigger follows.
    expect([cast?.request.decidingPlayer, cast?.request.turn, cast?.request.step]).toEqual([
      'P2',
      5,
      'draw',
    ]);
    expect([target?.request.decidingPlayer, target?.request.turn, target?.request.step]).toEqual([
      'P1',
      5,
      'draw',
    ]);
    expect(run.engine.getState().eventLog.filter((event) => event.type === 'draw')).toHaveLength(2);
  });

  it('clause 2: another opponent’s draw during someone else’s draw step triggers it', () => {
    const run = runScenario(file, scenario('bowmasters-other-opponent-draws-in-their-turn'));
    const [cast, target] = run.answered.filter((entry) => entry.step !== null);
    // P3 draws during P2's draw step: not P3's own draw step, so the exemption does not apply.
    expect([cast?.request.decidingPlayer, cast?.request.turn, cast?.request.step]).toEqual([
      'P3',
      5,
      'draw',
    ]);
    expect(cast?.request.activePlayer).toBe('P2');
    expect([target?.request.decidingPlayer, target?.request.turn, target?.request.step]).toEqual([
      'P1',
      5,
      'draw',
    ]);
  });
});
