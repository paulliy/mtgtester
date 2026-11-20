/** Eladamri, Lord of Leaves: scenarios in ../../scenarios/eladamri-lord-of-leaves.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/eladamri-lord-of-leaves.json', import.meta.url),
);

describe('Eladamri, Lord of Leaves', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
