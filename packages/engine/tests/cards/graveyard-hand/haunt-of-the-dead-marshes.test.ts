/** Haunt of the Dead Marshes (graveyard and hand batch): scenarios in ../../scenarios/haunt-of-the-dead-marshes.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/haunt-of-the-dead-marshes.json', import.meta.url),
);

describe('Haunt of the Dead Marshes', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('the ability is offered only while you control a legendary creature', () => {
    const offered = (id: string) =>
      (firstDecisionOf(file, { ...scenario(id), script: [] }, 'P1')?.legalActions ?? []).some(
        (action) => action.description.startsWith('Haunt of the Dead Marshes (graveyard)'),
      );
    expect(offered('haunt-of-the-dead-marshes-return')).toBe(true);
    expect(offered('haunt-of-the-dead-marshes-no-legend')).toBe(false);
  });
});
