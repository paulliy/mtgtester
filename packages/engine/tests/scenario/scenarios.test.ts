/**
 * Every scenario file under `tests/scenarios/` runs here (ADR 0034 decision 10): built with
 * strict invariants, driven by its script, and held to its expectations.
 */
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from './runner';

const directory = new URL('../scenarios/', import.meta.url);
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort();

describe.each(files)('%s', (name) => {
  const file = loadScenarioFile(new URL(name, directory));
  it.each(file.scenarios.map((scenario) => [scenario.id, scenario] as const))(
    '%s',
    (_id, scenario) => {
      expect(scenarioFailures(runScenario(file, scenario), scenario)).toEqual([]);
    },
  );
});
