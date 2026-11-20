/** Timeless Dragon (graveyard and hand batch): scenarios in ../../scenarios/timeless-dragon.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/timeless-dragon.json', import.meta.url));

describe('Timeless Dragon', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('eternalize: the token is a 4/4 Zombie, and the ability is sorcery speed', () => {
    const run = runScenario(file, scenario('timeless-dragon-eternalize'));
    const state = run.engine.getState();
    const token = state.battlefield.find((permanent) => permanent.name === 'Timeless Dragon')!;
    const view = run.engine.view('P1').battlefield.find((permanent) => permanent.id === token.id)!;
    expect([view.power, view.toughness]).toEqual([4, 4]);
    expect(view.typeLine).toMatch(/Zombie/);
    const offered = (
      firstDecisionOf(file, scenario('timeless-dragon-eternalize-sorcery-speed'), 'P1')
        ?.legalActions ?? []
    ).some((action) => action.description.includes('Eternalize'));
    expect(offered).toBe(false);
  });
});
