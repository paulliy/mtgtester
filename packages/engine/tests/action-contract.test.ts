import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions } from '../src/actions/legal';
import type { PriorityActionPayload } from '../src/actions/legal';
import type { GameGen } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { prepareScenario } from '../src/testing/prepared-scenario';
import {
  checkContinuations,
  cloneContractContext,
  contractOutcomes,
} from './helpers/contract-harness';
import { bear, copies, forest, gameConfig, oracle } from './fixtures';

const draw = oracle({
  name: 'Draw contract',
  typeLine: 'Sorcery',
  manaCost: '{G}',
  oracleText: 'Draw a card.',
});
const bolt = oracle({
  name: 'Damage contract',
  typeLine: 'Instant',
  manaCost: '{G}',
  oracleText: 'Damage contract deals 2 damage to any target.',
});

function scenario(seed: string) {
  const ctx = createGame(
    gameConfig(
      [{ cards: [...copies(8, forest), draw, bolt, bear()] }, { cards: copies(8, forest) }],
      { seed },
    ),
  );
  prepareScenario(ctx, {
    currentTurnPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    turnNumber: 3,
    hand: [{ playerId: 'P1', cardNames: ['Draw contract', 'Damage contract', 'Forest'] }],
    battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Forest', 'Test Bear'] }],
  });
  return ctx;
}

describe('bounded independent action contracts', () => {
  it.each(['action:1', 'action:2', 'action:3', 'action:4', 'action:5', 'action:6'])(
    'every offered non-pass action and target applies from the same context (%s)',
    (seed) => {
      const ctx = scenario(seed);
      const before = cloneContractContext(ctx);
      const options = computePriorityOptions(ctx, ctx.state.players[0]!).filter((option) =>
        ['castSpell', 'playLand', 'activateAbility'].includes(option.type),
      );
      expect(options.filter((option) => option.type === 'castSpell').length).toBeGreaterThanOrEqual(
        2,
      );
      for (const option of options) {
        const outcomes = contractOutcomes({
          decisionType: 'priority',
          player: 'P1',
          prompt: seed,
          options: [option],
        });
        expect(outcomes.length, `${seed}: ${option.description}`).toBeGreaterThan(0);
        for (const outcome of outcomes) {
          const result = checkContinuations(ctx, (copy) =>
            applyPriorityAction(
              copy,
              copy.state.players[0]!,
              option.payload as PriorityActionPayload,
              outcome,
            ),
          );
          expect(
            result.failures,
            `${seed}: ${option.description}: ${JSON.stringify(option.payload)}`,
          ).toEqual([]);
          expect(result.completions).toBeGreaterThan(0);
        }
      }
      expect(ctx.state).toEqual(before.state);
      expect(ctx.defs).toEqual(before.defs);
      expect(ctx.debugLog).toEqual(before.debugLog);
      expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
    },
  );

  it('clones definition maps, pending triggers, counters, debug logs, and cached layers independently', () => {
    const ctx = scenario('clone');
    const permanent = ctx.state.battlefield.find((item) => item.name === 'Test Bear')!;
    expect(computeCharacteristics(ctx, permanent).power).toBe(2);
    ctx.rng.nextUint32();
    const copy = cloneContractContext(ctx);
    const copiedPermanent = copy.state.battlefield.find((item) => item.id === permanent.id)!;
    copiedPermanent.counters['+1/+1'] = 3;
    copy.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: permanent.cardId,
      sourceOracleId: permanent.oracleId,
      sourceName: permanent.name,
      ability: {
        kind: 'triggered',
        trigger: { when: 'dies', subject: { kind: 'self' } },
        targets: [],
        effects: [],
      },
    });
    copy.state.nextObjectNum++;
    copy.debugLog.push({ turn: 3, category: 'engine', message: 'copy only' });
    copy.defs.get(permanent.oracleId)!.name = 'Copy only';
    expect(computeCharacteristics(copy, copiedPermanent).power).toBe(5);
    expect(computeCharacteristics(ctx, permanent).power).toBe(2);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ctx.state.nextObjectNum).toBe(copy.state.nextObjectNum - 1);
    expect(ctx.defs.get(permanent.oracleId)!.name).toBe('Test Bear');
    expect(ctx.debugLog).not.toEqual(copy.debugLog);
    expect(ctx.rng.nextUint32()).toBe(copy.rng.nextUint32());
  });

  it('finds a dead end hidden behind a later choice, even when the first choice succeeds', () => {
    const ctx = scenario('bad-menu');
    const result = checkContinuations(ctx, function* (): GameGen<void> {
      const outcome = yield {
        decisionType: 'general',
        player: 'P1',
        prompt: 'Adversarial payment',
        options: [
          { type: 'safe', description: 'Safe' },
          { type: 'deadEnd', description: 'Dead end' },
        ],
      };
      if (outcome.index === 1) throw new Error('remaining cost has no payment');
    });
    expect(result.completions).toBe(1);
    expect(result.failures).toMatchObject([
      {
        prompt: 'Adversarial payment',
        message: 'remaining cost has no payment',
        prefix: [{ index: 1 }],
      },
    ]);
  });

  it('fails required evidence when decision or response bounds are exhausted', () => {
    const result = checkContinuations(
      scenario('bound'),
      function* (): GameGen<void> {
        while (true)
          yield {
            decisionType: 'general',
            player: 'P1',
            prompt: 'Loop',
            options: [{ type: 'loop', description: 'Loop' }],
          };
      },
      { maxRuns: 8, maxDecisions: 2, maxOutcomes: 2 },
    );
    expect(result.failures).toMatchObject([{ message: 'contract decision bound 2 exceeded' }]);
    expect(() =>
      contractOutcomes(
        {
          decisionType: 'general',
          player: 'P1',
          prompt: 'Split',
          options: [{ type: 'mana', description: 'Mana' }],
          manaSplit: { amount: 1000000, colors: ['W', 'U', 'B', 'R', 'G'] },
        },
        2,
      ),
    ).toThrow('contract outcome bound 2 exceeded');
  });
});
