/**
 * Gonti, Lord of Luxury (EDHREC coverage plan, Phase 2 face-down cards): its clauses as scenarios in
 * ../scenarios/gonti-lord-of-luxury.json, driven through the production engine. A script that meets a decision it
 * does not expect fails the run, and the run is asserted, so that fails the test on an `expect`.
 */
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFile,
  runScenario,
  scenarioFailures,
  type ScenarioRun,
} from '../scenario/runner';

const file = loadScenarioFile(new URL('../scenarios/gonti-lord-of-luxury.json', import.meta.url));

describe('Gonti, Lord of Luxury', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    let run: ScenarioRun | undefined;
    expect(() => {
      run = runScenario(file, entry);
    }).not.toThrow();
    expect(scenarioFailures(run!, entry)).toEqual([]);
  });

  it("gonti-c02-privacy — only Gonti's controller can see the face-down card; its owner cannot (CR 406.3)", () => {
    const run = runScenario(
      file,
      file.scenarios.find(({ id }) => id === 'gonti-later-turn')!,
    );
    const exiled = (seat: string) =>
      run.engine
        .view(seat)
        .exile.map((card) => card.name)
        .filter((name) => name === 'Scenario Elk' || name === 'Face-down card');
    expect(exiled('P1')).toEqual(['Scenario Elk']);
    expect(exiled('P2')).toEqual(['Face-down card']);
    expect(exiled('P3')).toEqual(['Face-down card']);
    const board = (seat: string) =>
      run.engine
        .playerState(seat)
        .exile.map((card) => card.name)
        .filter((name) => name === 'Scenario Elk' || name === 'Face-down card');
    expect(board('P1')).toEqual(['Scenario Elk']);
    expect(board('P2')).toEqual(['Face-down card']);
  });

  it('gonti-c02-lasts — the cast permission outlasts the turn it was made', () => {
    const run = runScenario(
      file,
      file.scenarios.find(({ id }) => id === 'gonti-later-turn')!,
    );
    const elk = run.engine.getState().exile.find((card) => card.name === 'Scenario Elk') as
      { playableUntilEotBy?: string; castOnlyUntilEot?: true } | undefined;
    expect(run.engine.getState().turnNumber).toBeGreaterThan(4);
    expect(elk?.playableUntilEotBy).toBe('P1');
    expect(elk?.castOnlyUntilEot).toBe(true);
  });
});
