/**
 * The layer cache leaves `tapped` out of its key while the last layer pass read no tapped status
 * (ADR 0007, amendment 2), so a tap alone, which is every state the mana planner searches, costs
 * no layer pass. These tests pin that a tap is a hit on a board nothing reads it on, a miss where
 * something does (Iymrith's ward), that a reader arriving switches the key back, and that every
 * tapped read a layer pass can reach is counted.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const iymrith = () =>
  oracle({
    name: 'Iymrith, Desert Doom',
    typeLine: 'Legendary Creature — Dragon',
    manaCost: '{4}{U}{U}',
    power: '5',
    toughness: '5',
    oracleText: "Flying\nIymrith, Desert Doom has ward {4} as long as it's untapped.",
  });

const passes = (read: () => void): number => {
  const before = engineWork();
  read();
  return engineWorkSince(before).layerPasses;
};

describe('layer cache and tapped status', () => {
  it('layer-tap-hit — tapping a land on a board that reads no tapped status is a cache hit', () => {
    const ctx = game();
    const lands = [spawn(ctx, 'P1', forest()), spawn(ctx, 'P1', forest())];
    const first = computeAllCharacteristics(ctx);
    expect(passes(() => (lands[0]!.tapped = true))).toBe(0);
    expect(passes(() => expect(computeAllCharacteristics(ctx)).toBe(first))).toBe(0);
    lands[1]!.tapped = true;
    expect(passes(() => computeAllCharacteristics(ctx))).toBe(0);
  });

  it('layer-tap-reader-miss — where a static reads tapped status, a tap is a miss', () => {
    const ctx = game();
    const dragon = spawn(ctx, 'P1', iymrith());
    expect(computeCharacteristics(ctx, dragon).ward).not.toBeNull();
    dragon.tapped = true;
    let ward: unknown;
    expect(passes(() => (ward = computeCharacteristics(ctx, dragon).ward))).toBe(1);
    expect(ward).toBeNull();
  });

  it('layer-tap-reader-arrives — a reader entering puts tapped back in the key', () => {
    const ctx = game();
    spawn(ctx, 'P1', forest());
    computeAllCharacteristics(ctx); // cached with tapped out of the key
    const dragon = spawn(ctx, 'P1', iymrith());
    dragon.tapped = true;
    expect(computeCharacteristics(ctx, dragon).ward).toBeNull();
    dragon.tapped = false;
    expect(computeCharacteristics(ctx, dragon).ward).not.toBeNull();
    dragon.tapped = true;
    expect(computeCharacteristics(ctx, dragon).ward).toBeNull();
  });

  it('layer-tap-reader-leaves — once the reader is gone, taps are hits again', () => {
    const ctx = game();
    const land = spawn(ctx, 'P1', forest());
    const dragon = spawn(ctx, 'P1', iymrith());
    computeAllCharacteristics(ctx);
    ctx.state.battlefield = ctx.state.battlefield.filter((p) => p !== dragon);
    computeAllCharacteristics(ctx);
    land.tapped = true;
    expect(passes(() => computeAllCharacteristics(ctx))).toBe(0);
  });

  it('layer-tap-reads-counted — a layer pass reaches tapped status only through tappedState', () => {
    // The files a layer pass runs: the pass itself, the conditions and values it evaluates, the
    // selectors it matches and the object facts they read. A raw `.tapped` read in one of them
    // would go uncounted, and the cache would answer for the permanent as it was before a tap.
    // Building a candidate or a fact (`tapped: perm.tapped`) is not a read; matching one is.
    const src = join(__dirname, '../src');
    const files = [
      'effects/continuous.ts',
      'effects/values.ts',
      'cards/condition.ts',
      'cards/selector.ts',
      'cards/source-identity.ts',
    ];
    const raw = files.flatMap((file) =>
      readFileSync(join(src, file), 'utf8')
        .split('\n')
        .map((line, index) => ({ line: line.trim(), where: `${file}:${index + 1}` }))
        .filter(
          ({ line }) =>
            !line.startsWith('*') &&
            !line.startsWith('//') &&
            /\.tapped\b/.test(line) &&
            !/^tapped: \w+\.tapped,$/.test(line) &&
            !/return permanent\.tapped === true;$/.test(line),
        )
        .map(({ where, line }) => `${where} ${line}`),
    );
    expect(raw).toEqual([]);
  });
});
