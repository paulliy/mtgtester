/**
 * Hunter's Prowess — "Until end of turn, target creature gets +3/+3 and gains trample and
 * 'Whenever this creature deals combat damage to a player, draw that many cards.'" Composes
 * from existing primitives (`pumpUntilEot`, `grantKeywordUntilEot`, `grantAbilityUntilEot`,
 * `draw` with a `damageDealt` `Value`) but had no behavioral test proving the combination
 * actually draws cards when the granted trigger fires.
 */

import { describe, expect, it } from 'vitest';
import { executeAbility } from '../src/effects/resolve';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import { interpretCard } from '../src/cards/interpret';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const huntersProwess = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: 'e1a776d2-fb3a-4215-a14e-4b6e9bda95df',
    name: "Hunter's Prowess",
    typeLine: 'Sorcery',
    manaCost: '{3}{G}',
    power: null,
    toughness: null,
    oracleText:
      'Until end of turn, target creature gets +3/+3 and gains trample and "Whenever this creature deals combat damage to a player, draw that many cards."',
  });

const bear = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' });

function pod(): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(6, forest) })), { seed: 'hunters-prowess' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe("Hunter's Prowess", () => {
  it('pumps, grants trample, and grants a draw-on-combat-damage trigger', () => {
    const ctx = pod();
    const p1 = ctx.state.players[0]!;
    const bearPerm = spawn(ctx, 'P1', bear());

    const def = interpretCard(huntersProwess());
    expect(def.modeled).toBe(true);

    pump(
      executeAbility(
        ctx,
        { cardId: 'prowess-1', name: "Hunter's Prowess", oracleId: def.oracleId, controllerId: 'P1' },
        def.spellAbility!,
        [bearPerm.id],
      ),
    );

    const chars = computeCharacteristics(ctx, bearPerm);
    expect(chars).toMatchObject({ power: 5, toughness: 5 });
    expect(chars.keywords).toContain('trample');

    const initialHand = p1.hand.length;
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [{ permanent: bearPerm, amount: 5 }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const pending = ctx.state.pendingTriggers[0]!;

    pump(
      executeAbility(
        ctx,
        { cardId: pending.sourceCardId, name: pending.sourceName, oracleId: pending.sourceOracleId, controllerId: pending.controllerId },
        pending.ability,
        [],
        pending.triggerObjectCardId,
        pending.scope,
      ),
    );

    expect(p1.hand.length).toBe(initialHand + 5);
  });
});
