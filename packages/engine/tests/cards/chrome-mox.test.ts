/**
 * Chrome Mox through the scenario runner (card authoring plan, phase 3 step 5): its two clauses
 * re-expressed as scenarios in ../scenarios/chrome-mox.json, beside its direct tests in
 * pr11-lifecycle.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { loadScenarioFile, runScenario, scenarioFailures } from '../scenario/runner';

const file = loadScenarioFile(new URL('../scenarios/chrome-mox.json', import.meta.url));
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;
const actions = (run: ReturnType<typeof runScenario>) =>
  run.stoppedAt?.legalActions.map((action) => action.description) ?? [];

describe('Chrome Mox', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('chrome-mox-c02-colors — a green card imprinted offers no red spell to cast', () => {
    const run = runScenario(file, scenario('chrome-mox-only-the-exiled-colors'));
    expect(actions(run).some((action) => action.startsWith('Cast Scenario Imp'))).toBe(false);
    expect(actions(run).some((action) => action.startsWith('Cast Scenario Sprout'))).toBe(false);
  });

  it('chrome-mox-c02-nothing-imprinted — exiling nothing leaves no spell castable', () => {
    const run = runScenario(file, scenario('chrome-mox-decline'));
    expect(actions(run).filter((action) => action.startsWith('Cast '))).toEqual([]);
  });

  it('chrome-mox-c01-types — an artifact or land card is never offered to exile', () => {
    const run = runScenario(file, scenario('chrome-mox-no-artifact-or-land'));
    const offered = run.answered.flatMap(({ request }) =>
      request.legalActions.map((action) => action.description),
    );
    expect(offered.filter((action) => action.startsWith('Exile '))).toEqual([]);
    const imprint = runScenario(file, scenario('chrome-mox-decline')).answered.find(({ request }) =>
      request.legalActions.some((action) => action.description === 'Exile nothing'),
    );
    expect(imprint?.request.legalActions.map((action) => action.description)).toEqual([
      'Exile Scenario Flame',
      'Exile Scenario Imp',
      'Exile nothing',
    ]);
  });
});
