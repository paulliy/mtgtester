/** Master of the Pearl Trident: scenarios in ../../scenarios/master-of-the-pearl-trident.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/master-of-the-pearl-trident.json', import.meta.url),
);

describe('Master of the Pearl Trident', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
