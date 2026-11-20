/** Drift of Phantasms (graveyard and hand batch): scenarios in ../../scenarios/drift-of-phantasms.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/drift-of-phantasms.json', import.meta.url));

describe('Drift of Phantasms', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it("transmute is sorcery speed: not offered on an opponent's turn", () => {
    const decision = firstDecisionOf(
      file,
      { ...scenario('drift-of-phantasms-transmute'), turn: { player: 'P2' }, script: [] },
      'P1',
    );
    const descriptions = decision?.legalActions.map((action) => action.description) ?? [];
    expect(descriptions.some((text) => text.includes('Transmute'))).toBe(false);
  });
});
