/** Bonders' Enclave (graveyard and hand batch): scenarios in ../../scenarios/bonders-enclave.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/bonders-enclave.json', import.meta.url));

describe("Bonders' Enclave", () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('the draw ability is offered only with power 4 or greater', () => {
    const offered = (id: string) =>
      (firstDecisionOf(file, scenario(id), 'P1')?.legalActions ?? []).some((action) =>
        action.description.includes('Draw a card'),
      );
    expect(offered('bonders-enclave-no-power-4')).toBe(false);
  });
});
