/** Troll of Khazad-dûm (evasion and blocking batch): scenarios in ../../scenarios/troll-of-khazad-dum.json. */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/troll-of-khazad-dum.json', import.meta.url));

describe('Troll of Khazad-dûm', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });
});
