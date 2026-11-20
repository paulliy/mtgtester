/** Anointer Priest (graveyard and hand batch): scenarios in ../../scenarios/anointer-priest.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/anointer-priest.json', import.meta.url));

describe('Anointer Priest', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('embalm: the token is a 1/3 Zombie, and the ability is sorcery speed', () => {
    const run = runScenario(file, scenario('anointer-priest-embalm'));
    const state = run.engine.getState();
    const token = state.battlefield.find((permanent) => permanent.name === 'Anointer Priest')!;
    const view = run.engine.view('P1').battlefield.find((permanent) => permanent.id === token.id)!;
    expect([view.power, view.toughness]).toEqual([1, 3]);
    expect(view.typeLine).toMatch(/Zombie/);
    const offered = (
      firstDecisionOf(file, scenario('anointer-priest-embalm-sorcery-speed'), 'P1')?.legalActions ??
      []
    ).some((action) => action.description.includes('Embalm'));
    expect(offered).toBe(false);
  });
});
