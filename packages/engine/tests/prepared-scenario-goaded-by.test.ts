import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import { prepareScenario, type PreparedScenarioSpec } from '../src/testing/prepared-scenario';
import { copies, forest, gameConfig, oracle } from './fixtures';

const BEAR = oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' });

function arrange(goadedBy: string | undefined) {
  const ctx = createGame(
    gameConfig([
      { cards: copies(5, forest) },
      { cards: [BEAR, BEAR, ...copies(5, forest)] },
      ...[1, 2].map(() => ({ cards: copies(5, forest) })),
    ]),
  );
  const spec = {
    currentTurnPlayer: 'P2',
    phase: 'precombatMain',
    step: null,
    turnNumber: 4,
    hand: [],
    battlefield: [
      { playerId: 'P2', cardNames: ['Lab Bear'], ...(goadedBy === undefined ? {} : { goadedBy }) },
      { playerId: 'P2', cardNames: ['Lab Bear'] },
    ],
  } as PreparedScenarioSpec;
  return { ctx, run: () => prepareScenario(ctx, spec) };
}

describe('prepared scenario goaded-by', () => {
  it('arranges only the named permanent as goaded by the player on an earlier turn', () => {
    const { ctx, run } = arrange('P1');
    run();
    const [goaded, free] = ctx.state.battlefield.filter((perm) => perm.name === 'Lab Bear');
    expect(goaded?.goadedBy).toEqual([{ goaderId: 'P1', appliedTurn: 3 }]);
    expect(free?.goadedBy).toBeUndefined();
  });

  it('rejects a goading player that is not in the game', () => {
    expect(() => arrange('P9').run()).toThrow(/unknown goading player P9/);
  });

  it('rejects a goad by the current turn player, which would already have ended (CR 701.15a)', () => {
    expect(() => arrange('P2').run()).toThrow(
      /cannot arrange a goad by P2 on that player's own turn/,
    );
  });
});
