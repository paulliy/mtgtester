/**
 * `millAndReturnSpells` (Kairi, the Swirling Sky's second mode: "Mill six cards, then return up
 * to two instant and/or sorcery cards from your graveyard to your hand"). A regression test for
 * a library-top/bottom mixup: `resolve.ts` read `library[library.length - 1]` as the top card,
 * while every other site in the engine — `drawCards`, and `moveObject`'s `libraryPosition: 'top'`
 * (`unshift`) — treats index 0 as the top. The op was milling from the BOTTOM of the library.
 */

import { describe, expect, it } from 'vitest';
import { executeAbility } from '../src/effects/resolve';
import type { EffectSource } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('millAndReturnSpells', () => {
  it('mills the top of the library, not the bottom', () => {
    const ctx = pod('mill-top');
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;

    // `conjure(..., 'library')` unshifts, so conjuring in this order leaves the library, top to
    // bottom, as: Top 1..6, Bottom A, Bottom B.
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Bottom B', typeLine: 'Creature — Bear', power: '1', toughness: '1' }),
      'library',
    );
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Bottom A', typeLine: 'Creature — Bear', power: '1', toughness: '1' }),
      'library',
    );
    for (let i = 6; i >= 1; i--) {
      conjure(
        ctx,
        'P1',
        oracle({ name: `Top ${i}`, typeLine: 'Creature — Bear', power: '1', toughness: '1' }),
        'library',
      );
    }
    // `pod()`'s deck fills the rest of the library below these; only the top 8 are asserted.
    expect(p1.library.slice(0, 8).map((c) => c.name)).toEqual([
      'Top 1',
      'Top 2',
      'Top 3',
      'Top 4',
      'Top 5',
      'Top 6',
      'Bottom A',
      'Bottom B',
    ]);

    const source: EffectSource = {
      cardId: 'c-kairi',
      name: 'Kairi',
      oracleId: 'kairi',
      controllerId: 'P1',
    };
    pump(
      executeAbility(
        ctx,
        source,
        { kind: 'triggered', targets: [], effects: [{ op: 'millAndReturnSpells' }] },
        [],
      ),
    );

    const graveyardNames = new Set(p1.graveyard.map((c) => c.name));
    for (let i = 1; i <= 6; i++) expect(graveyardNames.has(`Top ${i}`)).toBe(true);
    expect(graveyardNames.has('Bottom A')).toBe(false);
    expect(graveyardNames.has('Bottom B')).toBe(false);

    // Bottom A/B are now on top of what's left — the bug milled them instead of the real top.
    expect(p1.library.slice(0, 2).map((c) => c.name)).toEqual(['Bottom A', 'Bottom B']);
  });
});
