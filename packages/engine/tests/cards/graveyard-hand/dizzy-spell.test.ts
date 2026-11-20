/** Dizzy Spell (graveyard and hand batch): scenarios in ../../scenarios/dizzy-spell.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/dizzy-spell.json', import.meta.url));

describe('Dizzy Spell', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it("transmute is sorcery speed: not offered on an opponent's turn", () => {
    const decision = firstDecisionOf(
      file,
      { ...scenario('dizzy-spell-transmute'), turn: { player: 'P2' }, script: [] },
      'P1',
    );
    const descriptions = decision?.legalActions.map((action) => action.description) ?? [];
    expect(descriptions.some((text) => text.includes('Transmute'))).toBe(false);
  });
});
