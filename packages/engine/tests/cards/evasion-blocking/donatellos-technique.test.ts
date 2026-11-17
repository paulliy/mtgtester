/** Donatello's Technique (evasion-and-blocking batch): scenarios in ../../scenarios/donatellos-technique.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/donatellos-technique.json', import.meta.url),
);

describe("Donatello's Technique", () => {
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
      ...scenario('donatellos-technique-sneak'),
      script: scenario('donatellos-technique-sneak').script.slice(0, 1),
    });
    console.log(
      run.stoppedAt
        ? JSON.stringify([
            run.stoppedAt.step,
            run.stoppedAt.phase,
            run.stoppedAt.decidingPlayer,
            run.stoppedAt.legalActions.map((a) => a.description),
          ])
        : 'null',
    );
    expect(
      run.stoppedAt!.legalActions.some((action) => action.description.includes('(alternate cost)')),
    ).toBe(true);
  });

  it('sneak is not offered once the attacker is blocked', () => {
    const blocked = scenario('donatellos-technique-sneak-blocked');
    const run = runScenario(file, blocked);
    console.log(
      run.stoppedAt
        ? JSON.stringify([
            run.stoppedAt.step,
            run.stoppedAt.phase,
            run.stoppedAt.decidingPlayer,
            run.stoppedAt.legalActions.map((a) => a.description),
          ])
        : 'null',
    );
    expect(
      run.stoppedAt?.legalActions.some((action) =>
        action.description.includes('(alternate cost)'),
      ) ?? false,
    ).toBe(false);
  });

  it('sneak is not offered in the precombat main phase', () => {
    expect(
      offered('donatellos-technique-sneak-main-phase').some((text) =>
        text.includes('(alternate cost)'),
      ),
    ).toBe(false);
  });
});
