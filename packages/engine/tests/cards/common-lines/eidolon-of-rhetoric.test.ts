/** Eidolon of Rhetoric (common blocking lines, PR #89): scenarios in ../../scenarios/eidolon-of-rhetoric.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/eidolon-of-rhetoric.json', import.meta.url));

describe('Eidolon of Rhetoric', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
