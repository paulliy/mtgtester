/** Professional Face-Breaker (pilot-new batch): scenarios in ../../scenarios/professional-face-breaker.json. */
import { describe, expect, it } from 'vitest';
import {
  choiceAfterScript,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/professional-face-breaker.json', import.meta.url),
);
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;
const offered = (id: string): string[] =>
  runScenario(file, scenario(id)).stoppedAt!.legalActions.map((action) => action.description);

describe('Professional Face-Breaker', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clause 1, negative: one creature alone cannot block it, so the block is refused', () => {
    const lone = scenario('face-breaker-menace-lone-blocker');
    expect(choiceAfterScript(file, { ...lone, script: lone.script.slice(0, 2) })?.prompt).toEqual(
      expect.stringMatching(/^Declare blockers — fix the flagged problem/),
    );
  });

  it('clause 2: the Treasure trigger asks nothing', () => {
    expect(choiceAfterScript(file, scenario('face-breaker-one-treasure'))).toBeNull();
  });

  it('clause 3, negative: an artifact that is not a Treasure does not pay the sacrifice', () => {
    const actions = offered('face-breaker-no-treasure-no-sacrifice');
    expect(actions).toContainEqual(expect.stringMatching(/^Cast Scenario Bear/));
    expect(actions).not.toContainEqual(expect.stringMatching(/Sacrifice a Treasure/));
  });

  it('clause 3, negative: on your next turn the exiled card can no longer be cast', () => {
    // Two untapped Forests pay for Scenario Bear, so only the lapsed permission keeps it uncast.
    // Read at P1's own precombat main four turns on, where the control below could cast it.
    const request = runScenario(file, scenario('face-breaker-permission-ends')).stoppedAt;
    expect(request?.turn).toBe(8);
    expect(request?.phase).toBe('precombatMain');
    expect(request?.decidingPlayer).toBe('P1');
    expect(offered('face-breaker-permission-ends')).not.toContainEqual(
      expect.stringMatching(/Scenario Bear/),
    );
  });

  it('clause 3: the exiled card is castable in the postcombat main phase of the turn it was exiled', () => {
    // The positive control for the negative above: same position, same Forests, same turn.
    const run = runScenario(file, scenario('face-breaker-cast-exiled-this-turn'));
    const cast = run.answered.find((entry) => entry.step?.choose === '/^Cast Scenario Bear/');
    expect(cast?.request.phase).toBe('postcombatMain');
    expect(cast?.request.turn).toBe(4);
    expect(cast?.request.legalActions.map((action) => action.description)).toContainEqual(
      expect.stringMatching(/^Cast Scenario Bear/),
    );
  });
});
