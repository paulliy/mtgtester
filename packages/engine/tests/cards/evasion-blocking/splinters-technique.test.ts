/** Splinter's Technique (evasion-and-blocking batch): scenarios in ../../scenarios/splinters-technique.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/splinters-technique.json', import.meta.url));

describe("Splinter's Technique", () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;
  const offered = (id: string) =>
    (runScenario(file, scenario(id)).stoppedAt?.legalActions ?? []).map(
      (action) => action.description,
    );

  it('sneak is offered in the declare blockers step with an unblocked attacker', () => {
    const run = runScenario(file, {
      ...scenario('splinters-technique-sneak'),
      script: scenario('splinters-technique-sneak').script.slice(0, 1),
    });
    expect(
      run.stoppedAt!.legalActions.some((action) => action.description.includes('(alternate cost)')),
    ).toBe(true);
  });

  it('sneak is not offered once the attacker is blocked', () => {
    const blocked = scenario('splinters-technique-sneak-blocked');
    const run = runScenario(file, blocked);
    expect(
      run.stoppedAt?.legalActions.some((action) =>
        action.description.includes('(alternate cost)'),
      ) ?? false,
    ).toBe(false);
  });

  it('sneak is not offered in the precombat main phase', () => {
    expect(
      offered('splinters-technique-sneak-main-phase').some((text) =>
        text.includes('(alternate cost)'),
      ),
    ).toBe(false);
  });
});
