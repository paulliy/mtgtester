/** Loxodon Gatekeeper (common blocking lines, PR #89): scenarios in ../../scenarios/loxodon-gatekeeper.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/loxodon-gatekeeper.json', import.meta.url));

describe('Loxodon Gatekeeper', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
