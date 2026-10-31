/**
 * Academy Manufactor replaces creating a Clue, Food or Treasure with creating one of each. "Create
 * a tapped Food token" is an instruction of the creation event that replacement modifies (CR
 * 614.1), so every token created instead enters tapped, as the Peregrin Took ruling illustrates.
 */
import { describe, expect, it } from 'vitest';
import { FOOD } from '../src/cards/tokens';
import { createGame } from '../src/state/game';
import { createToken, createTokens } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, spawn } from './fixtures';
import { pinStore } from './scenario/pin-store';

function withManufactor(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  spawn(ctx, 'P1', pinStore.get('Academy Manufactor'));
  return ctx;
}

const tokens = (ctx: GameContext) =>
  ctx.state.battlefield
    .filter((perm) => perm.isToken)
    .map((perm) => [perm.name, perm.tapped])
    .sort();

describe('Academy Manufactor and a tapped token', () => {
  it('academy-manufactor-tapped-event — a tapped Food event makes a tapped Clue, Food and Treasure', () => {
    const ctx = withManufactor('manufactor-tapped-event');
    createTokens(ctx, FOOD, 1, 'P1', true);
    expect(tokens(ctx)).toEqual([
      ['Clue', true],
      ['Food', true],
      ['Treasure', true],
    ]);
  });

  it('academy-manufactor-tapped-single — the single-token path taps every replacement token too', () => {
    const ctx = withManufactor('manufactor-tapped-single');
    createToken(ctx, FOOD, 'P1', true, true, true, true);
    expect(tokens(ctx)).toEqual([
      ['Clue', true],
      ['Food', true],
      ['Treasure', true],
    ]);
  });

  it('academy-manufactor-untapped-event — an untapped Food event leaves all three untapped', () => {
    const ctx = withManufactor('manufactor-untapped-event');
    createTokens(ctx, FOOD, 1, 'P1');
    expect(tokens(ctx)).toEqual([
      ['Clue', false],
      ['Food', false],
      ['Treasure', false],
    ]);
  });
});
