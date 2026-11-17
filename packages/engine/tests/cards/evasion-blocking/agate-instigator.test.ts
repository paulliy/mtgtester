/** Agate Instigator (evasion-and-blocking batch): scenarios in ../../scenarios/agate-instigator.json. */
import { describe, expect, it } from 'vitest';
import type { EnginePermanent } from '../../../src/state/types';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/agate-instigator.json', import.meta.url));

describe('Agate Instigator', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;
  const copies = (id: string) =>
    runScenario(file, scenario(id))
      .engine.getState()
      .battlefield.filter((perm) => perm.name === 'Agate Instigator') as EnginePermanent[];

  it('offspring paid: the second copy is a 1/1 token, the first a card', () => {
    const [original, token] = copies(`agate-instigator-offspring-paid`);
    expect(original!.isToken).toBe(false);
    expect(token!.isToken).toBe(true);
    const run = runScenario(file, scenario(`agate-instigator-offspring-paid`));
    const view = run.engine.view('P1').battlefield.find((perm) => perm.id === token!.id);
    expect([view?.power, view?.toughness]).toEqual([1, 1]);
  });

  it('offspring declined: exactly one permanent, not a token', () => {
    const found = copies(`agate-instigator-offspring-declined`);
    expect(found.map((perm) => perm.isToken)).toEqual([false]);
  });

  it('offspring is only offered when its extra cost can be paid', () => {
    const poor = { ...scenario(`agate-instigator-offspring-declined`), script: [] };
    poor.seats = {
      ...poor.seats,
      P1: { ...poor.seats.P1!, battlefield: poor.seats.P1!.battlefield!.slice(0, 2).concat([]) },
    };
    const decision = firstDecisionOf(file, poor, 'P1');
    const descriptions = decision?.legalActions.map((action) => action.description) ?? [];
    expect(descriptions.some((text) => text.startsWith(`Cast Agate Instigator`))).toBe(true);
    expect(descriptions.some((text) => text.includes('offspring'))).toBe(false);
  });
});
