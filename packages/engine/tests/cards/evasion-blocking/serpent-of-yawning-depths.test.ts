/** Serpent of Yawning Depths (evasion and blocking batch): scenarios in ../../scenarios/serpent-of-yawning-depths.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/serpent-of-yawning-depths.json', import.meta.url),
);

describe('Serpent of Yawning Depths', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
