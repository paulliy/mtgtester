import { describe, expect, it } from 'vitest';
import { playPreparedScenario } from '../src/flow/game';
import { phaseOutControlledPermanents } from '../src/state/phasing';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { changeController } from '../src/state/objects';
import { priorityCheckpoint } from '../src/sba/sba';
import { pump, copies, gameConfig, oracle, spawn, swamp } from './fixtures';

function game(): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(24, swamp) })),
      {
        seed: 'phasing-departed-controller',
      },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

describe('phasing schedules after the due player leaves', () => {
  it('keeps an owned permanent phased through the immediate extra and normal turns, then phases it in on the next applicable untap', () => {
    const ctx = game();
    const permanent = spawn(
      ctx,
      'P2',
      oracle({
        name: 'P2-owned artifact',
        typeLine: 'Artifact',
        types: ['Artifact'],
        manaCost: '{0}',
        cmc: 0,
        power: null,
        toughness: null,
      }),
    );
    changeController(ctx, permanent, 'P1');
    phaseOutControlledPermanents(ctx, 'P1');
    ctx.state.extraTurns = ['P2'];

    const advanceOneTurn = () =>
      pump(
        playPreparedScenario(ctx, {
          currentTurnPlayer: ctx.state.currentTurnPlayer,
          phase: 'precombatMain',
          step: null,
          turnNumber: ctx.state.turnNumber,
          hand: [],
          battlefield: [],
          continueThroughNextPrecombatMain: true,
        }),
        (decision) => {
          const pass = decision.options.findIndex((option) => option.type === 'pass');
          return { index: Math.max(pass, 0), targets: new Map() };
        },
      );

    // P2 takes the gifted extra turn; P1 leaves before their normal turn would resume.
    advanceOneTurn();
    expect(ctx.state.currentTurnPlayer).toBe('P2');
    expect(ctx.state.normalTurnResumeAfter).toBe('P1');
    expect(ctx.state.phasedOut?.some((record) => record.permanent.id === permanent.id)).toBe(true);
    ctx.state.players.find((player) => player.id === 'P1')!.hasLost = true;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.turnOrder).not.toContain('P1');
    expect(permanent.controllerId).toBe('P2');

    advanceOneTurn();
    expect(ctx.state.currentTurnPlayer).toBe('P2');
    expect(ctx.state.normalTurnResumeAfter).toBeUndefined();
    expect(ctx.state.phasedOut?.some((record) => record.permanent.id === permanent.id)).toBe(true);

    advanceOneTurn();
    expect(ctx.state.currentTurnPlayer).toBe('P3');
    expect(ctx.state.phasedOut?.some((record) => record.permanent.id === permanent.id)).toBe(true);

    advanceOneTurn();
    expect(ctx.state.currentTurnPlayer).toBe('P4');
    expect(ctx.state.phasedOut?.some((record) => record.permanent.id === permanent.id)).toBe(true);

    advanceOneTurn();
    expect(ctx.state.currentTurnPlayer).toBe('P2');
    expect(ctx.state.phasedOut?.some((record) => record.permanent.id === permanent.id)).toBe(false);
    expect(ctx.state.battlefield.find((candidate) => candidate.id === permanent.id)).toBe(
      permanent,
    );
    expect(permanent.ownerId).toBe('P2');
    expect(permanent.controllerId).toBe('P2');
    expect(ctx.state.eventLog.filter((event) => event.type === 'phaseIn')).toHaveLength(1);
  });
});
