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
    expect(offered('face-breaker-permission-ends')).not.toContainEqual(
      expect.stringMatching(/Scenario Bear/),
    );
  });
});
