/** Cyan, Vengeful Samurai (common blocking lines, PR #89): scenarios in ../../scenarios/cyan-vengeful-samurai.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/cyan-vengeful-samurai.json', import.meta.url),
);

describe('Cyan, Vengeful Samurai', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
