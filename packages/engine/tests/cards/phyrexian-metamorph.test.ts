/**
 * Phyrexian Metamorph (EDHREC coverage plan, Phase 2 copy with exceptions): its clauses as
 * scenarios in ../scenarios/phyrexian-metamorph.json, driven through the production engine.
 */
import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../../src/effects/continuous';
import { moveObject } from '../../src/state/objects';
import { createGame } from '../../src/state/game';
import type { EnginePermanent } from '../../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from '../fixtures';
import { pinStore } from '../scenario/pin-store';
import {
  loadScenarioFile,
  runScenario,
  scenarioFailures,
  type ScenarioRun,
} from '../scenario/runner';

const file = loadScenarioFile(new URL('../scenarios/phyrexian-metamorph.json', import.meta.url));
const scenario = (id: string) => file.scenarios.find((candidate) => candidate.id === id)!;

describe('Phyrexian Metamorph', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    let run: ScenarioRun | undefined;
    expect(() => {
      run = runScenario(file, entry);
    }).not.toThrow();
    expect(scenarioFailures(run!, entry)).toEqual([]);
  });

  it('metamorph-c02-candidates — only artifacts and creatures are offered to copy', () => {
    const run = runScenario(file, scenario('metamorph-only-artifacts-and-creatures'));
    const copy = run.answered.find(({ request }) =>
      request.legalActions.some((action) => action.description === 'Enter normally'),
    );
    expect(copy?.request.legalActions.map((action) => action.description).sort()).toEqual([
      'Copy Scenario Bear',
      'Copy Scenario Rock',
      'Enter normally',
    ]);
  });

  it('metamorph-c02-copy-of-copy — a Clone copying the Metamorph copy is an artifact too (CR 707.9b)', () => {
    const ctx = createGame(
      gameConfig(
        [0, 1].map(() => ({ cards: copies(8, forest) })),
        { seed: 'metamorph-copy-of-copy' },
      ),
    );
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.phase = 'precombatMain';
    const bear = spawn(
      ctx,
      'P2',
      oracle({ name: 'Copy Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    const metamorph = conjure(ctx, 'P1', pinStore.get('Phyrexian Metamorph'), 'hand');
    const asCopy = pump(
      moveObject(ctx, metamorph, { zone: 'battlefield', controllerId: 'P1' }),
      (decision) =>
        decision.options[0]?.description === 'Copy Copy Bear'
          ? { index: 0, targets: new Map() }
          : undefined,
    ).value as EnginePermanent;
    expect(computeCharacteristics(ctx, asCopy).types.sort()).toEqual(['Artifact', 'Creature']);
    const clone = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Copy Clone',
        typeLine: 'Creature — Shapeshifter',
        manaCost: '{3}{U}',
        power: '0',
        toughness: '0',
        oracleText:
          'You may have this creature enter as a copy of any creature on the battlefield.',
      }),
      'hand',
    );
    let offered: string[] = [];
    const cloned = pump(
      moveObject(ctx, clone, { zone: 'battlefield', controllerId: 'P1' }),
      (decision) => {
        offered = decision.options.map((option) => option.description);
        // The Metamorph copy is the second Copy Bear on the battlefield, after P2's.
        return { index: 1, targets: new Map() };
      },
    ).value as EnginePermanent;
    expect(offered).toEqual(['Copy Copy Bear', 'Copy Copy Bear', 'Enter normally']);
    expect(computeCharacteristics(ctx, cloned).types.sort()).toEqual(['Artifact', 'Creature']);
    expect(computeCharacteristics(ctx, bear).types).toEqual(['Creature']);
  });

  it('metamorph-c02-original-unchanged — copying adds the artifact type to the copy only', () => {
    const ctx = createGame(
      gameConfig(
        [0, 1].map(() => ({ cards: copies(8, forest) })),
        { seed: 'metamorph-original' },
      ),
    );
    const bear = spawn(
      ctx,
      'P2',
      oracle({ name: 'Copy Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    const metamorph = conjure(ctx, 'P1', pinStore.get('Phyrexian Metamorph'), 'hand');
    const asCopy = pump(moveObject(ctx, metamorph, { zone: 'battlefield', controllerId: 'P1' }))
      .value as EnginePermanent;
    expect(asCopy.name).toBe('Copy Bear');
    expect(computeCharacteristics(ctx, asCopy).power).toBe(2);
    expect(computeCharacteristics(ctx, bear).types).toEqual(['Creature']);
  });
});
