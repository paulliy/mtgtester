/**
 * A tutor is not a draw. Maelstrom of the Spirit Dragon's "search your library for a Dragon card,
 * put it into your hand" must not emit a `draw` event, because "whenever an opponent draws"
 * (Smothering Tithe) and "whenever you draw" watchers key on that event (CR 121.1, 701.23).
 */

import { describe, expect, it } from 'vitest';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pick, pump } from './fixtures';

function pod(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(10, forest) })),
      { seed: 'maelstrom-search' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const maelstrom = () =>
  oracle({
    name: 'Maelstrom of the Spirit Dragon',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText:
      '{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a Dragon spell or an Omen spell.\n{4}, {T}, Sacrifice this land: Search your library for a Dragon card, reveal it, put it into your hand, then shuffle.',
  });

describe('Maelstrom of the Spirit Dragon — search', () => {
  it('puts the Dragon in hand without drawing it', () => {
    const ctx = pod();
    const def = interpretCard(maelstrom());
    const search = def.activatedAbilities.find((a) =>
      a.ability.effects.some((e) => e.op === 'searchLibrary'),
    )?.ability as Ability;
    expect(search).toBeDefined();

    const dragon = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Dragon',
        typeLine: 'Creature — Dragon',
        manaCost: '{4}{R}',
        power: '5',
        toughness: '5',
      }),
      'library',
    );
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Not A Dragon', typeLine: 'Artifact', manaCost: '{0}' }),
      'library',
    );

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'c-maelstrom',
          name: 'Maelstrom of the Spirit Dragon',
          oracleId: def.oracleId,
          controllerId: 'P1',
        },
        search,
        [],
      ),
      (d) => pick(d, 'Test Dragon'),
    );

    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.hand.some((c) => c.cardId === dragon.cardId)).toBe(true);
    expect(ctx.state.eventLog.filter((e) => e.type === 'draw')).toEqual([]);
  });
});
