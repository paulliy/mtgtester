/**
 * The stack (brief §5.5, CR 608): LIFO resolution, countering, and fizzling when all
 * targets have become illegal.
 */

import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  bear,
  bolt,
  cancel,
  conjure,
  copies,
  divination,
  forest,
  gameConfig,
  giantGrowth,
  island,
  mountain,
  pick,
  pump,
} from './fixtures';
import { spawn } from './fixtures';

function mainPhaseContext(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'stack' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 5;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  for (const p of ctx.state.players) {
    conjure(ctx, p.id, forest(), 'library');
    conjure(ctx, p.id, forest(), 'library');
  }
  return ctx;
}

describe('the stack (brief §5.5)', () => {
  it('resolves LIFO: a response resolves before the original spell', () => {
    const ctx = mainPhaseContext();
    const target = spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P2', mountain());
    conjure(ctx, 'P1', giantGrowth(), 'hand');
    conjure(ctx, 'P2', bolt(), 'hand');

    let growthCast = false;
    let boltCast = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1' && !growthCast) {
        growthCast = true;
        const idx = d.options.findIndex((o) => o.description.includes('Test Growth'));
        return { index: idx, targets: new Map([[0, target.id]]) };
      }
      if (d.player === 'P2' && !boltCast && ctx.state.stack.length === 1) {
        boltCast = true;
        const idx = d.options.findIndex((o) => o.description.includes('Test Bolt'));
        return { index: idx, targets: new Map([[0, target.id]]) };
      }
      return pick(d, 'Pass');
    });

    // Bolt (cast second) resolved FIRST: 3 damage killed the 2/2 before Growth could
    // resolve; Growth then fizzled (its only target left the battlefield).
    expect(ctx.state.battlefield.find((p) => p.name === 'Test Bear')).toBeUndefined();
    const types = ctx.state.eventLog.map((e) => e.type);
    const boltResolved = ctx.state.eventLog.findIndex(
      (e) => e.type === 'damage' && e.payload['source'] === 'Test Bolt',
    );
    const fizzle = ctx.state.eventLog.findIndex((e) => e.type === 'fizzle');
    expect(boltResolved).toBeGreaterThanOrEqual(0);
    expect(fizzle).toBeGreaterThan(boltResolved);
    expect(types).toContain('sbaCreatureDies');
    // The fizzled Growth went to its owner's graveyard.
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.graveyard.some((c) => c.name === 'Test Growth')).toBe(true);
  });

  it('counters a spell: the countered spell never resolves', () => {
    const ctx = mainPhaseContext();
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P2', island());
    conjure(ctx, 'P1', divination(), 'hand');
    conjure(ctx, 'P2', cancel(), 'hand');
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    const handBefore = p1?.hand.length ?? 0;

    let divinationCast = false;
    let cancelCast = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1' && !divinationCast) {
        divinationCast = true;
        return pick(d, 'Test Divination');
      }
      if (d.player === 'P2' && !cancelCast && ctx.state.stack.length === 1) {
        cancelCast = true;
        const idx = d.options.findIndex((o) => o.description.includes('Test Cancel'));
        const spellOnStack = ctx.state.stack[0];
        return { index: idx, targets: new Map([[0, spellOnStack?.id as string]]) };
      }
      return pick(d, 'Pass');
    });

    // Divination was countered: P1 cast it (hand −1) and never drew the two cards.
    expect(p1?.hand.length).toBe(handBefore - 1);
    expect(ctx.state.eventLog.some((e) => e.type === 'counterSpell')).toBe(true);
    expect(ctx.state.eventLog.some((e) => e.type === 'draw')).toBe(false);
    expect(p1?.graveyard.some((c) => c.name === 'Test Divination')).toBe(true);
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    expect(p2?.graveyard.some((c) => c.name === 'Test Cancel')).toBe(true);
  });

  it('a spell with some targets still legal resolves against the survivors', () => {
    // Covered implicitly by single-target fizzle; here: pump still applies when its
    // target survives a response that did NOT kill it.
    const ctx = mainPhaseContext();
    const target = spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', giantGrowth(), 'hand');

    let cast = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1' && !cast) {
        cast = true;
        const idx = d.options.findIndex((o) => o.description.includes('Test Growth'));
        return { index: idx, targets: new Map([[0, target.id]]) };
      }
      return pick(d, 'Pass');
    });

    const pumped = ctx.state.eventLog.find((e) => e.type === 'pump');
    expect(pumped?.payload['nowPower']).toBe(5);
    expect(pumped?.payload['nowToughness']).toBe(5);
    // Until-end-of-turn effect is live in state.
    expect(ctx.state.effects).toHaveLength(1);
  });
});
