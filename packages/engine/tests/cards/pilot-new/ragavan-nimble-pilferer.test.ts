/** Ragavan, Nimble Pilferer (pilot-new batch): scenarios in ../../scenarios/ragavan-nimble-pilferer.json. */
import { describe, expect, it } from 'vitest';
import {
  choiceAfterScript,
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/ragavan-nimble-pilferer.json', import.meta.url),
);
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;

describe('Ragavan, Nimble Pilferer', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it("clause 1: the exiled card is P2's, and you may only cast it this turn", () => {
    // The trigger asks nothing: it is not a "you may".
    expect(choiceAfterScript(file, scenario('ragavan-land-exiled'))).toBeNull();
    const { engine } = runScenario(file, scenario('ragavan-land-exiled'));
    // One card is exiled: the top one.
    expect(engine.getState().exile.filter((card) => card.ownerId === 'P2')).toHaveLength(1);
    const forest = engine.getState().exile.find((card) => card.name === 'Forest');
    expect(forest).toMatchObject({
      ownerId: 'P2',
      playableUntilEotBy: 'P1',
      castOnlyUntilEot: true,
    });
  });

  it('clause 2: dashed, it can attack the turn it enters', () => {
    const dash = scenario('ragavan-dash');
    const cast = firstDecisionOf(file, { ...dash, script: [] }, 'P1');
    expect(cast?.legalActions.map((action) => action.description) ?? []).toContain(
      'Cast Ragavan, Nimble Pilferer ({1}{R}) (dash)',
    );
    const attack = choiceAfterScript(file, { ...dash, script: dash.script.slice(0, 1) });
    const declaration = attack?.legalActions.find((action) => action.type === 'attackDeclaration');
    expect(declaration?.targets?.length ?? 0).toBe(1);
  });

  it('clause 2, negative: cast for {R}, it is not offered as an attacker', () => {
    expect(choiceAfterScript(file, scenario('ragavan-cast-normally'))).toBeNull();
  });
});
