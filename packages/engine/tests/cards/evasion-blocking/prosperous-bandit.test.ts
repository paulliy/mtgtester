/** Prosperous Bandit (evasion-and-blocking batch): scenarios in ../../scenarios/prosperous-bandit.json. */
import { describe, expect, it } from 'vitest';
import type { EnginePermanent } from '../../../src/state/types';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/prosperous-bandit.json', import.meta.url));

describe('Prosperous Bandit', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;
  const copies = (id: string) =>
    runScenario(file, scenario(id))
      .engine.getState()
      .battlefield.filter((perm) => perm.name === 'Prosperous Bandit') as EnginePermanent[];

  it('offspring paid: the second copy is a 1/1 token, the first a card', () => {
    const [original, token] = copies(`prosperous-bandit-offspring-paid`);
    expect(original!.isToken).toBe(false);
    expect(token!.isToken).toBe(true);
    const run = runScenario(file, scenario(`prosperous-bandit-offspring-paid`));
    const view = run.engine.view('P1').battlefield.find((perm) => perm.id === token!.id);
    expect([view?.power, view?.toughness]).toEqual([1, 1]);
  });

  it('offspring declined: exactly one permanent, not a token', () => {
    const found = copies(`prosperous-bandit-offspring-declined`);
    expect(found.map((perm) => perm.isToken)).toEqual([false]);
  });

  it('offspring is only offered when its extra cost can be paid', () => {
    const poor = { ...scenario(`prosperous-bandit-offspring-declined`), script: [] };
    poor.seats = {
      ...poor.seats,
      P1: { ...poor.seats.P1!, battlefield: poor.seats.P1!.battlefield!.slice(0, 3).concat([]) },
    };
    const decision = firstDecisionOf(file, poor, 'P1');
    const descriptions = decision?.legalActions.map((action) => action.description) ?? [];
    expect(descriptions.some((text) => text.startsWith(`Cast Prosperous Bandit`))).toBe(true);
    expect(descriptions.some((text) => text.includes('offspring'))).toBe(false);
  });
});
