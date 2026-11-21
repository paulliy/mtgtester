/**
 * The layer-cache digest (`digestOf` in `effects/layer-cache.ts`) is the cache key: two states
 * with one digest share one layer pass, so a collision returns another state's characteristics.
 * The old 32-bit `(h ^ x) * prime` digest collided about 3 times in 16 benchmark games. These
 * tests pin a digest wide and mixed enough that collisions do not happen in practice.
 */
import { describe, expect, it } from 'vitest';
import { digestOf } from '../src/effects/layer-cache';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, spawn } from './fixtures';

function game(): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.phase = 'precombatMain';
  return ctx;
}

const bear = () =>
  oracle({
    name: 'Digest Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '2',
  });

describe('layer digest', () => {
  it('layer-digest-no-collisions — every tapped/untapped mix of 18 lands digests apart', () => {
    // The mana planner's shape: the same board with different lands tapped. Any 32-bit digest
    // collides here about 8 times (n^2 / 2^33 for n = 2^18), and the old one did 12 times; a
    // 53-bit one collides about once in 70,000 runs, so a collision means it lost width or mixing.
    const ctx = game();
    const lands = Array.from({ length: 18 }, (_, i) => spawn(ctx, i % 2 ? 'P1' : 'P2', forest()));
    const seen = new Set<number>();
    for (let mask = 0; mask < 1 << lands.length; mask++) {
      lands.forEach((land, i) => (land.tapped = ((mask >> i) & 1) === 1));
      seen.add(digestOf(ctx, undefined, false, true));
    }
    expect(seen.size).toBe(1 << lands.length);
  });

  it('layer-digest-nearby — 160,000 states a few counters and life points apart digest apart', () => {
    const ctx = game();
    const [p1, p2] = ctx.state.players;
    const a = spawn(ctx, 'P1', bear());
    const b = spawn(ctx, 'P2', bear());
    const seen = new Set<number>();
    for (let life1 = 0; life1 < 100; life1++)
      for (let life2 = 0; life2 < 100; life2++)
        for (let counters = 0; counters < 16; counters++) {
          p1!.life = life1;
          p2!.life = life2;
          a.counters['+1/+1'] = counters & 3;
          b.counters['-1/-1'] = counters >> 2;
          seen.add(digestOf(ctx, undefined, false, true));
        }
    expect(seen.size).toBe(160_000);
  });

  it('layer-digest-wide — digests use more than 32 bits and stay exact integers', () => {
    const ctx = game();
    const perm = spawn(ctx, 'P1', bear());
    let above32 = 0;
    for (let n = 0; n < 64; n++) {
      perm.counters['+1/+1'] = n;
      const digest = digestOf(ctx, undefined, false, true);
      expect(Number.isSafeInteger(digest)).toBe(true);
      expect(digest).toBeGreaterThanOrEqual(0);
      if (digest > 0xffffffff) above32++;
    }
    // The top 21 bits are zero for about one digest in two million.
    expect(above32).toBe(64);
  });

  it('layer-digest-order — the same values in different fields digest differently', () => {
    const ctx = game();
    const perm = spawn(ctx, 'P1', bear());
    perm.copyAddSupertypes = ['Legendary'];
    perm.copyRemoveSupertypes = [];
    const added = digestOf(ctx, undefined, false, true);
    perm.copyAddSupertypes = [];
    perm.copyRemoveSupertypes = ['Legendary'];
    expect(digestOf(ctx, undefined, false, true)).not.toBe(added);
  });

  it('layer-digest-deterministic — one state digests the same in a fresh game', () => {
    const build = () => {
      const ctx = game();
      spawn(ctx, 'P1', bear()).counters['+1/+1'] = 2;
      return digestOf(ctx, undefined, true, true);
    };
    expect(build()).toBe(build());
  });
});
