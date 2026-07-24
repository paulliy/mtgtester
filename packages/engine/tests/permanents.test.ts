/**
 * Planeswalker and Battle permanents (CR 306.5b, 310.6, 704.5i/s): a permanent spell of
 * either type resolves ONTO the battlefield (not the graveyard), entering with its printed
 * loyalty/defense, and leaves via the matching state-based action when that reaches zero.
 *
 * Real cards of both types are double-faced and still halt on their ability text; these
 * cover the structural permanent handling that used to send them to the graveyard.
 */

import { describe, expect, it } from 'vitest';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pick, pump, spawn } from './fixtures';

const walker = (loyalty = '3'): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Beacon',
    typeLine: 'Legendary Planeswalker — Beacon',
    manaCost: '{2}',
    power: null,
    toughness: null,
    loyalty,
  });

const battle = (defense = '2'): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Siege',
    typeLine: 'Battle — Siege',
    manaCost: '{2}',
    power: null,
    toughness: null,
    defense,
  });

function ctx4(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'permanents' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('planeswalker & battle permanents', () => {
  it('a planeswalker spell resolves onto the battlefield with its starting loyalty', () => {
    const ctx = ctx4();
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', walker('5'), 'hand');

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Test Beacon'));
      return i > 0 ? { index: i, targets: new Map() } : pick(d, 'Pass');
    });

    const pw = ctx.state.battlefield.find((p) => p.name === 'Test Beacon');
    expect(pw).toBeDefined();
    expect(pw?.counters['loyalty']).toBe(5);
    // It did NOT get routed to the graveyard.
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.graveyard.some((c) => c.name === 'Test Beacon')).toBe(false);
  });

  it('a planeswalker at 0 loyalty leaves; a positive-loyalty one survives the SBA', () => {
    const ctx = ctx4();
    const alive = spawn(ctx, 'P1', walker('3'));
    expect(alive.counters['loyalty']).toBe(3);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === alive.cardId)).toBeDefined();

    alive.counters['loyalty'] = 0;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === alive.cardId)).toBeUndefined();
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.graveyard.some((c) => c.cardId === alive.cardId)).toBe(true);
  });

  it('a battle enters with its defense and leaves via SBA when defense hits 0', () => {
    const ctx = ctx4();
    const b = spawn(ctx, 'P1', battle('2'));
    expect(b.counters['defense']).toBe(2);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === b.cardId)).toBeDefined();

    b.counters['defense'] = 0;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === b.cardId)).toBeUndefined();
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.graveyard.some((c) => c.cardId === b.cardId)).toBe(true);
  });
});
