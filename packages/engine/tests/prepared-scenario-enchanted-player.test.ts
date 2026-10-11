import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import { prepareScenario, type PreparedScenarioSpec } from '../src/testing/prepared-scenario';
import { copies, forest, gameConfig, oracle } from './fixtures';

const CURSE = oracle({
  name: 'Lab Curse',
  typeLine: 'Enchantment — Aura Curse',
  manaCost: '{1}',
  oracleText: 'Enchant player',
});

function arrange(enchantedPlayerId: string) {
  const ctx = createGame(
    gameConfig([
      { cards: [CURSE, ...copies(4, forest)] },
      ...[1, 2, 3].map(() => ({ cards: copies(5, forest) })),
    ]),
  );
  const spec = {
    currentTurnPlayer: 'P3',
    phase: 'precombatMain',
    step: null,
    turnNumber: 2,
    hand: [],
    battlefield: [{ playerId: 'P1', cardNames: ['Lab Curse'], enchantedPlayerId }],
  } as PreparedScenarioSpec;
  return { ctx, run: () => prepareScenario(ctx, spec) };
}

describe('prepared scenario enchanted player', () => {
  it('arranges an Aura on the battlefield as already enchanting the named player', () => {
    const { ctx, run } = arrange('P2');
    run();
    const [curse] = ctx.state.battlefield.filter((perm) => perm.name === 'Lab Curse');
    expect(curse?.attachedTo).toBe('P2');
    expect(curse?.controllerId).toBe('P1');
  });

  it('rejects a player that is not in the game', () => {
    expect(() => arrange('P9').run()).toThrow(/unknown enchanted player P9/);
  });
});
