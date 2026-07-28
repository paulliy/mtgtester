import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const cyclonicRift = () =>
  oracle({
    name: 'Cyclonic Rift',
    manaCost: '{1}{U}',
    cmc: 2,
    colors: ['U'],
    colorIdentity: ['U'],
    typeLine: 'Instant',
    oracleText:
      'Return target nonland permanent you don\'t control to its owner\'s hand.\nOverload {6}{U} (You may cast this spell for its overload cost. If you do, change "target" in its text to "each.")',
  });

function pod(seed = 'alt-casts-test'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('Increment 17: Alternative Casts (Overload)', () => {
  it('models Cyclonic Rift with alternative overload cast', () => {
    const def = interpretCard(cyclonicRift());
    expect(def.modeled).toBe(true);
    expect(def.alternativeCasts).toBeDefined();
    expect(def.alternativeCasts?.length).toBe(1);
    expect(def.alternativeCasts?.[0]?.kind).toBe('overload');
  });

  it('resolves Overload mode returning all nonland opponent permanents to hand', () => {
    const ctx = pod();
    const p1Perm = spawn(ctx, 'P1', oracle({ name: 'P1 Bear', typeLine: 'Creature' }));
    const p2Perm1 = spawn(ctx, 'P2', oracle({ name: 'P2 Bear 1', typeLine: 'Creature' }));
    const p2Perm2 = spawn(ctx, 'P2', oracle({ name: 'P2 Artifact', typeLine: 'Artifact' }));
    const p2Land = spawn(ctx, 'P2', oracle({ name: 'P2 Forest', typeLine: 'Land' }));

    const def = interpretCard(cyclonicRift());
    const overloadAbility = {
      kind: 'spell' as const,
      targets: [],
      effects: [{ op: 'overloadBounceAllNonlandOpponents' as const }],
    };

    pump(
      executeAbility(
        ctx,
        { cardId: 'rift-1', name: 'Cyclonic Rift', oracleId: def.oracleId, controllerId: 'P1' },
        overloadAbility,
        [],
      ),
    );

    // P1 permanent untouched
    expect(ctx.state.battlefield.find((p) => p.id === p1Perm.id)).toBeDefined();
    // P2 nonland permanents bounced to P2's hand
    expect(ctx.state.battlefield.find((p) => p.id === p2Perm1.id)).toBeUndefined();
    expect(ctx.state.battlefield.find((p) => p.id === p2Perm2.id)).toBeUndefined();
    // P2 land untouched
    expect(ctx.state.battlefield.find((p) => p.id === p2Land.id)).toBeDefined();
  });
});
