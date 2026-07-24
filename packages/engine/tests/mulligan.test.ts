/**
 * London mulligan with the multiplayer free first mulligan (brief §5.8, CR 103.4c):
 * keep/mulligan in turn order, simultaneous re-draws, bottom `max(0, taken − 1)`.
 */

import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { runOpeningHands } from '../src/turn/mulligan';
import { copies, forest, gameConfig, pick, pump } from './fixtures';

function openingCtx(deckSize = 20): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(deckSize, forest) })),
      { seed: 'mulligan' },
    ),
  );
  ctx.state.activePlayerIndex = 0;
  ctx.state.currentTurnPlayer = 'P1';
  return ctx;
}

describe('London mulligan (brief §5.8)', () => {
  it('free first mulligan: hand sizes and bottoms are correct per mulligan count', () => {
    const ctx = openingCtx();
    const mullsWanted: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
    const mullsTaken: Record<string, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };

    pump(runOpeningHands(ctx), (d) => {
      if (d.decisionType === 'mulligan') {
        const wanted = mullsWanted[d.player] ?? 0;
        if ((mullsTaken[d.player] ?? 0) < wanted) {
          mullsTaken[d.player] = (mullsTaken[d.player] ?? 0) + 1;
          return pick(d, 'Mulligan');
        }
        return pick(d, 'Keep');
      }
      // bottomCards decisions: first card.
      return { index: 0, targets: new Map() };
    });

    const bySeat = Object.fromEntries(ctx.state.players.map((p) => [p.id, p]));
    // 0 mulligans → 7 cards; 1 → free, still 7; 2 → bottom 1 ⇒ 6; 3 → bottom 2 ⇒ 5.
    expect(bySeat['P1']?.hand).toHaveLength(7);
    expect(bySeat['P2']?.hand).toHaveLength(7);
    expect(bySeat['P3']?.hand).toHaveLength(6);
    expect(bySeat['P4']?.hand).toHaveLength(5);
    expect(bySeat['P1']?.mulligansTaken).toBe(0);
    expect(bySeat['P2']?.mulligansTaken).toBe(1);
    expect(bySeat['P3']?.mulligansTaken).toBe(2);
    expect(bySeat['P4']?.mulligansTaken).toBe(3);
    // Cards are conserved: hand + library = deck size.
    for (const p of ctx.state.players) {
      expect(p.hand.length + p.library.length).toBe(20);
    }
  });

  it('keep/mulligan decisions run in turn order from the starting player', () => {
    const ctx = openingCtx();
    ctx.state.activePlayerIndex = 2; // P3 starts
    ctx.state.currentTurnPlayer = 'P3';
    const order: string[] = [];
    pump(runOpeningHands(ctx), (d) => {
      if (d.decisionType === 'mulligan') order.push(d.player);
      return { index: 0, targets: new Map() }; // everyone keeps
    });
    expect(order).toEqual(['P3', 'P4', 'P1', 'P2']);
  });

  it('a player who mulligans to the cap must keep and bottoms their whole hand', () => {
    const ctx = openingCtx(30);
    pump(runOpeningHands(ctx), (d) => {
      if (d.decisionType === 'mulligan' && d.player === 'P1') return pick(d, 'Mulligan');
      return { index: 0, targets: new Map() };
    });
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.mulligansTaken).toBe(8);
    expect(p1?.hand).toHaveLength(0); // bottomed all 7 (max(0, 8−1) capped at hand size)
    expect(p1?.library).toHaveLength(30);
  });
});
