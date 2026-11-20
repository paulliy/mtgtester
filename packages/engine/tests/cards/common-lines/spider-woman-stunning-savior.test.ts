/** Spider-Woman, Stunning Savior (common blocking lines, PR #89): scenarios in ../../scenarios/spider-woman-stunning-savior.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/spider-woman-stunning-savior.json', import.meta.url),
);

describe('Spider-Woman, Stunning Savior', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
