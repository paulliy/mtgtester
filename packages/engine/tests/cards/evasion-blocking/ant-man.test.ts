/** Ant-Man, Elusive Avenger (evasion and blocking batch): scenarios in ../../scenarios/ant-man.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/ant-man.json', import.meta.url));

describe('Ant-Man, Elusive Avenger', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
