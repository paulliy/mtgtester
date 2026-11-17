/** Steelburr Champion (evasion-and-blocking batch): scenarios in ../../scenarios/steelburr-champion.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/steelburr-champion.json', import.meta.url));

describe('Steelburr Champion', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;
  const copies = (id: string) =>
    runScenario(file, scenario(id))
      .engine.getState()
      .battlefield.filter((perm) => perm.name === 'Steelburr Champion');

  it('offspring paid: the second copy is a 1/1 token, the first a card', () => {
    const [original, token] = copies(`steelburr-champion-offspring-paid`);
    expect(original!.isToken).toBe(false);
    expect(token!.isToken).toBe(true);
    const run = runScenario(file, scenario(`steelburr-champion-offspring-paid`));
    const view = run.engine.view('P1').battlefield.find((perm) => perm.id === token!.id);
    expect([view?.power, view?.toughness]).toEqual([1, 1]);
  });

  it('offspring declined: exactly one permanent, not a token', () => {
    const found = copies(`steelburr-champion-offspring-declined`);
    expect(found.map((perm) => perm.isToken)).toEqual([false]);
  });

  it('offspring is only offered when its extra cost can be paid', () => {
    const poor = { ...scenario(`steelburr-champion-offspring-declined`), script: [] };
    poor.seats = {
      ...poor.seats,
      P1: { ...poor.seats.P1!, battlefield: poor.seats.P1!.battlefield!.slice(0, 3).concat([]) },
    };
    const decision = firstDecisionOf(file, poor, 'P1');
    const descriptions = decision?.legalActions.map((action) => action.description) ?? [];
    expect(descriptions.some((text) => text.startsWith(`Cast Steelburr Champion`))).toBe(true);
    expect(descriptions.some((text) => text.includes('offspring'))).toBe(false);
  });
});
