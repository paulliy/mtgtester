/**
 * Provoke the Trolls — "Deals 3 damage to any target. If a creature is dealt damage this way, it
 * gets +5/+0 until end of turn." Exercises `conditionalEffect`'s new `checkTarget`, which checks
 * a resolved SPELL target (not the ambient trigger object) against a condition at resolution.
 */

import { describe, expect, it } from 'vitest';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { ofType } from '../src/cards/selector';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const bear = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' });

function pod(): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(6, forest) })), { seed: 'provoke-the-trolls' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

const provokeSource = { cardId: 'src', name: 'Provoke the Trolls', oracleId: 'ac844303-487b-49e9-9170-02892153ca6a', controllerId: 'P1' };
const provokeAbility = {
  kind: 'spell' as const,
  targets: [{ kind: 'anyTarget' as const }],
  effects: [
    { op: 'dealDamage' as const, target: 0, amount: { kind: 'const' as const, n: 3 } },
    {
      op: 'conditionalEffect' as const,
      checkTarget: 0,
      condition: { kind: 'triggerObjectMatches' as const, selector: ofType('Creature') },
      then: [{ op: 'pumpUntilEot' as const, target: 0, power: 5, toughness: 0 }],
      else: [],
    },
  ],
  description: 'test',
};

describe('Provoke the Trolls (conditionalEffect.checkTarget)', () => {
  it('pumps a creature target after dealing damage', () => {
    const ctx = pod();
    const foe = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, provokeSource, provokeAbility, [foe.id]));

    expect(foe.damageMarked).toBe(3);
    const effect = ctx.state.effects.find((e) => e.kind === 'ptDelta');
    expect(effect).toBeDefined();
    expect((effect as { power: number }).power).toBe(5);
  });

  it('does not pump a player target', () => {
    const ctx = pod();
    const p2 = ctx.state.players[1]!;
    const before = p2.life;
    pump(executeAbility(ctx, provokeSource, provokeAbility, [p2.id]));

    expect(p2.life).toBe(before - 3);
    expect(ctx.state.effects.some((e) => e.kind === 'ptDelta')).toBe(false);
  });
});
