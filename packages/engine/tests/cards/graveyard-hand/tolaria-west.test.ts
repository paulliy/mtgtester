/** Tolaria West (graveyard and hand batch): scenarios in ../../scenarios/tolaria-west.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/tolaria-west.json', import.meta.url));

describe('Tolaria West', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it("transmute is sorcery speed: not offered on an opponent's turn", () => {
    const decision = firstDecisionOf(
      file,
      { ...scenario('tolaria-west-transmute'), turn: { player: 'P2' }, script: [] },
      'P1',
    );
    const descriptions = decision?.legalActions.map((action) => action.description) ?? [];
    expect(descriptions.some((text) => text.includes('Transmute'))).toBe(false);
  });
});
