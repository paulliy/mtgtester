/** Aven Wind Guide (graveyard and hand batch): scenarios in ../../scenarios/aven-wind-guide.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/aven-wind-guide.json', import.meta.url));

describe('Aven Wind Guide', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('embalm: the token is a 2/3 Zombie, and the ability is sorcery speed', () => {
    const run = runScenario(file, scenario('aven-wind-guide-embalm'));
    const state = run.engine.getState();
    const token = state.battlefield.find((permanent) => permanent.name === 'Aven Wind Guide')!;
    const view = run.engine.view('P1').battlefield.find((permanent) => permanent.id === token.id)!;
    expect([view.power, view.toughness]).toEqual([2, 3]);
    expect(view.typeLine).toMatch(/Zombie/);
    const offered = (
      firstDecisionOf(file, scenario('aven-wind-guide-embalm-sorcery-speed'), 'P1')?.legalActions ??
      []
    ).some((action) => action.description.includes('Embalm'));
    expect(offered).toBe(false);
  });
});
