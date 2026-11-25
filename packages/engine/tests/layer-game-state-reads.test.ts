/**
 * The layer cache leaves the game-level scalars (turn, phase, step, active player, life and zone
 * counts) and graveyards out of its key while the last pass read no game state: no condition, no
 * dynamic value and no turn-scoped selector test (`gameStateRead`). These tests pin that a new
 * step or turn costs no pass on a board nothing reads it on, that a static whose condition reads
 * the turn still updates as the turn changes, and that a turn-scoped selector does too.
 */
import { describe, expect, it } from 'vitest';
import { computeAllCharacteristics, computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { engineWork, engineWorkSince } from '../src/work-counters';
import { copies, forest, gameConfig, oracle, spawn } from './fixtures';

function game(): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.phase = 'precombatMain';
  return ctx;
}

const creature = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' });

const passes = (read: () => void): number => {
  const before = engineWork();
  read();
  return engineWorkSince(before).layerPasses;
};

/** The next turn, as the turn structure moves it: another active player and step, less life. */
function nextTurn(ctx: GameContext): void {
  ctx.state.turnNumber += 1;
  ctx.state.currentTurnPlayer = ctx.state.currentTurnPlayer === 'P1' ? 'P2' : 'P1';
  ctx.state.phase = 'beginning';
  ctx.state.step = 'upkeep';
  ctx.state.players[0]!.life -= 1;
}

describe('layer cache and game state', () => {
  it('layer-game-state-hit — a new turn on a board that reads no game state is a cache hit', () => {
    const ctx = game();
    spawn(ctx, 'P1', creature('Plain Bear'));
    spawn(ctx, 'P2', forest());
    const first = computeAllCharacteristics(ctx);
    nextTurn(ctx);
    expect(passes(() => expect(computeAllCharacteristics(ctx)).toBe(first))).toBe(0);
  });

  it('layer-game-state-condition — a static whose condition reads the turn follows it', () => {
    const ctx = game();
    const bear = spawn(ctx, 'P1', creature('Turn Bear'));
    // "As long as it's your turn, this creature has first strike."
    ctx.defs.get(bear.oracleId)!.staticEffects.push({
      affects: { kind: 'self' },
      condition: { kind: 'yourTurn' },
      op: { layer: 6, addKeyword: 'first strike' },
    });
    expect(computeCharacteristics(ctx, bear).keywords).toContain('first strike');
    nextTurn(ctx);
    let keywords: readonly string[] = [];
    expect(passes(() => (keywords = computeCharacteristics(ctx, bear).keywords))).toBe(1);
    expect(keywords).not.toContain('first strike');
    nextTurn(ctx);
    expect(computeCharacteristics(ctx, bear).keywords).toContain('first strike');
  });

  it('layer-game-state-selector — a static affecting creatures that entered this turn follows the turn', () => {
    const ctx = game();
    const lord = spawn(ctx, 'P1', creature('Fresh Lord'));
    const bear = spawn(ctx, 'P1', creature('Fresh Bear'));
    bear.enteredTurnNumber = ctx.state.turnNumber;
    // "Creatures that entered this turn get +1/+1."
    ctx.defs.get(lord.oracleId)!.staticEffects.push({
      affects: { kind: 'enteredThisTurn' },
      op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 },
    });
    expect(computeCharacteristics(ctx, bear).power).toBe(3);
    nextTurn(ctx);
    expect(computeCharacteristics(ctx, bear).power).toBe(2);
  });
});
