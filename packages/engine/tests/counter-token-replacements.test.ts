import { describe, expect, it } from 'vitest';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { createToken } from '../src/state/objects';
import { executeAbility, permanentSource } from '../src/effects/resolve';
import type { GameContext } from '../src/state/types';
import { bear, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { SOLDIER_1_1 } from '../src/cards/tokens';

function pod(seed = 'counter-token-replacements'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

/*
 * Oracle text below is copied VERBATIM from the printed cards (Scryfall bulk, checked
 * 2026-09-04). It used to be paraphrased - "it creates twice that many instead", "twice that
 * many of each of those counters", "put on that creature instead" - and no printing has ever
 * read that way. The tests passed against the paraphrase while the real Doubling Season and
 * Hardened Scales stayed unmodeled, which is the whole failure this file now guards against.
 * If you change these strings, change them to match a real printing.
 */
const doublingSeason = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Doubling Season',
    typeLine: 'Enchantment',
    manaCost: '{4}{G}',
    power: null,
    toughness: null,
    oracleText:
      'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.\nIf an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead.',
  });

const hardenedScales = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Hardened Scales',
    typeLine: 'Enchantment',
    manaCost: '{G}',
    power: null,
    toughness: null,
    oracleText:
      'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.',
  });

const oneCounterOnSource: Ability = {
  kind: 'activated',
  targets: [],
  effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }],
};

describe('token and counter replacement statics', () => {
  it('parses Doubling Season and Hardened Scales as generic rule statics', () => {
    const doubling = interpretCard(doublingSeason());
    const scales = interpretCard(hardenedScales());

    expect(doubling.modeled).toBe(true);
    expect(doubling.ruleStatics).toEqual([
      { kind: 'tokenCountMultiplier', multiplier: 2 },
      {
        kind: 'counterPlacementReplacement',
        filter: { kind: 'controller', who: 'you' },
        multiplier: 2,
        addition: 0,
      },
    ]);
    expect(scales.modeled).toBe(true);
    expect(scales.ruleStatics).toEqual([
      {
        kind: 'counterPlacementReplacement',
        filter: {
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Creature' },
            { kind: 'controller', who: 'you' },
          ],
        },
        counter: '+1/+1',
        multiplier: 1,
        addition: 1,
      },
    ]);
  });

  it('doubles one token-creation event and counters placed on a controlled permanent', () => {
    const ctx = pod();
    spawn(ctx, 'P1', doublingSeason());
    const target = spawn(ctx, 'P1', bear());

    for (let i = 0; i < 3; i++) createToken(ctx, SOLDIER_1_1, 'P1');
    expect(ctx.state.battlefield.filter((perm) => perm.isToken && perm.name === 'Soldier')).toHaveLength(6);

    pump(executeAbility(ctx, permanentSource(target), oneCounterOnSource, []));
    expect(target.counters['+1/+1']).toBe(2);
  });

  it('does not replace another player’s token or counter event', () => {
    const ctx = pod();
    spawn(ctx, 'P1', doublingSeason());
    const target = spawn(ctx, 'P2', bear());

    for (let i = 0; i < 3; i++) createToken(ctx, SOLDIER_1_1, 'P2');
    expect(ctx.state.battlefield.filter((perm) => perm.isToken && perm.name === 'Soldier')).toHaveLength(3);

    pump(executeAbility(ctx, permanentSource(target), oneCounterOnSource, []));
    expect(target.counters['+1/+1']).toBe(1);
  });

  it('adds one +1/+1 counter for Hardened Scales, including as-enter counters', () => {
    const ctx = pod();
    spawn(ctx, 'P1', hardenedScales());
    const target = spawn(ctx, 'P1', bear());

    pump(executeAbility(ctx, permanentSource(target), oneCounterOnSource, []));
    expect(target.counters['+1/+1']).toBe(2);

    const opponentTarget = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, permanentSource(opponentTarget), oneCounterOnSource, []));
    expect(opponentTarget.counters['+1/+1']).toBe(1);

    const entering = oracle({
      name: 'Test Entering Hydra',
      typeLine: 'Creature — Hydra',
      manaCost: '{2}{G}',
      power: '0',
      toughness: '0',
      oracleText: 'Test Entering Hydra enters the battlefield with one +1/+1 counter on it.',
    });
    const hydra = spawn(ctx, 'P1', entering);
    expect(hydra.counters['+1/+1']).toBe(2);
  });
});
