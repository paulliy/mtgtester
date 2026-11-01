/** Everflowing Chalice (pilot-new batch): scenarios in ../../scenarios/everflowing-chalice.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/everflowing-chalice.json', import.meta.url));
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;

describe('Everflowing Chalice', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  it('clause 3: kicked twice, its {C}{C} pays for a {2} creature', () => {
    const twice = scenario('everflowing-chalice-kicked-twice');
    const run = runScenario(file, { ...twice, script: twice.script.slice(0, 1) });
    expect(run.stoppedAt?.legalActions.map((action) => action.description) ?? []).toContainEqual(
      expect.stringMatching(/^Cast Scenario Ox/),
    );
  });

  it('clause 1: multikicker is offered once per {2} you can pay, and no further', () => {
    const casts = (
      firstDecisionOf(file, scenario('everflowing-chalice-kicked-twice'), 'P1')?.legalActions ?? []
    )
      .map((action) => action.description)
      .filter((description) => description.startsWith('Cast Everflowing Chalice'));
    expect(casts).toEqual([
      'Cast Everflowing Chalice ({0})',
      'Cast Everflowing Chalice ({2}) — kicker 1',
      'Cast Everflowing Chalice ({4}) — kicker 2',
    ]);
  });

  it('clause 3, negative: an unkicked Chalice has no counter to tap for, so a {1} spell is not offered', () => {
    const run = runScenario(file, scenario('everflowing-chalice-unkicked'));
    const actions = run.stoppedAt?.legalActions.map((action) => action.description) ?? [];
    // The Forest in hand keeps P1 being asked (the engine skips a priority with only a pass), so
    // this reads a real decision: P1 may play a land, and still cannot cast Scenario Mite.
    expect(actions).toContainEqual(expect.stringMatching(/^Play Forest/));
    expect(actions).not.toContainEqual(expect.stringMatching(/^Cast Scenario Mite/));
  });

  it('clause 3: with one charge counter on it, Chalice pays for a {1} spell', () => {
    const one = scenario('everflowing-chalice-one-counter-taps');
    const run = runScenario(file, { ...one, script: [] });
    // Control for the negative above: the same {1} spell is offered once a counter is there.
    expect(run.stoppedAt?.legalActions.map((action) => action.description) ?? []).toContainEqual(
      expect.stringMatching(/^Cast Scenario Mite/),
    );
  });
});
