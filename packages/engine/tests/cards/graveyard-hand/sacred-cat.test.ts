/** Sacred Cat (graveyard and hand batch): scenarios in ../../scenarios/sacred-cat.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/sacred-cat.json', import.meta.url));

describe('Sacred Cat', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('embalm: the token is a 1/1 Zombie, and the ability is sorcery speed', () => {
    const run = runScenario(file, scenario('sacred-cat-embalm'));
    const state = run.engine.getState();
    const token = state.battlefield.find((permanent) => permanent.name === 'Sacred Cat')!;
    const view = run.engine.view('P1').battlefield.find((permanent) => permanent.id === token.id)!;
    expect([view.power, view.toughness]).toEqual([1, 1]);
    expect(view.typeLine).toMatch(/Zombie/);
    const offered = (
      firstDecisionOf(file, scenario('sacred-cat-embalm-sorcery-speed'), 'P1')?.legalActions ?? []
    ).some((action) => action.description.includes('Embalm'));
    expect(offered).toBe(false);
  });
});
