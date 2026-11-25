/**
 * Read scopes (`effects/layer-cache.ts`): inside one, the layer digest is computed once per
 * distinct input and reused, so a loop that asks for each permanent's characteristics costs one
 * board digest rather than one per permanent. The scope is only sound while nothing the digest
 * reads changes, so strict games check that as each scope closes. A scope can be resumed on the
 * same unchanged state (`lastReadScope`), as the priority loop does from its checkpoint.
 */
import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../src/effects/continuous';
import { lastReadScope, withReadScope } from '../src/effects/layer-cache';
import { copyData } from '../src/state/copy-data';
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

const bear = () =>
  oracle({
    name: 'Scope Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '2',
  });

describe('layer read scopes', () => {
  it('layer-read-scope-same-answers — characteristics inside a scope match those outside', () => {
    const ctx = game();
    const perm = spawn(ctx, 'P1', bear());
    const outside = computeCharacteristics(ctx, perm);
    const inside = withReadScope(ctx, () => computeCharacteristics(ctx, perm));
    expect(inside).toEqual(outside);
  });

  it('layer-read-scope-fresh-after-close — a change after the scope closes is seen', () => {
    const ctx = game();
    const perm = spawn(ctx, 'P1', bear());
    withReadScope(ctx, () => computeCharacteristics(ctx, perm));
    perm.counters['+1/+1'] = 2;
    expect(computeCharacteristics(ctx, perm).power).toBe(4);
  });

  it('layer-read-scope-copies-digest-alone — a copy changed inside the scope is not stale', () => {
    const ctx = game();
    const perm = spawn(ctx, 'P1', bear());
    withReadScope(ctx, () => {
      computeCharacteristics(ctx, perm);
      const copy: GameContext = { ...ctx, state: copyData(ctx.state) };
      const copied = copy.state.battlefield.find((p) => p.cardId === perm.cardId)!;
      copied.counters['+1/+1'] = 1;
      expect(computeCharacteristics(copy, copied).power).toBe(3);
      expect(computeCharacteristics(ctx, perm).power).toBe(2);
    });
  });

  it('layer-read-scope-strict-mutation — a strict game throws on a layer input changed inside', () => {
    const ctx = game();
    ctx.strictInvariants = true;
    const perm = spawn(ctx, 'P1', bear());
    expect(() =>
      withReadScope(ctx, () => {
        computeCharacteristics(ctx, perm);
        perm.counters['+1/+1'] = 1;
      }),
    ).toThrow(/layer input changed inside a read scope/);
  });

  it('layer-read-scope-nested — a nested scope joins the outer one', () => {
    const ctx = game();
    const perm = spawn(ctx, 'P1', bear());
    const power = withReadScope(ctx, () =>
      withReadScope(ctx, () => computeCharacteristics(ctx, perm).power),
    );
    expect(power).toBe(2);
  });

  it('layer-read-scope-resume — a resumed scope reuses the digest it took', () => {
    const ctx = game();
    const perm = spawn(ctx, 'P1', bear());
    withReadScope(ctx, () => computeCharacteristics(ctx, perm));
    const board = lastReadScope(ctx);
    const before = engineWork();
    expect(withReadScope(ctx, () => computeCharacteristics(ctx, perm).power, board)).toBe(2);
    expect(engineWorkSince(before).layerDigests).toBe(0);
  });

  it('layer-read-scope-resume-not-last — only the last closed scope can be resumed', () => {
    const ctx = game();
    const perm = spawn(ctx, 'P1', bear());
    withReadScope(ctx, () => computeCharacteristics(ctx, perm));
    const stale = lastReadScope(ctx);
    perm.counters['+1/+1'] = 2;
    withReadScope(ctx, () => computeCharacteristics(ctx, perm));
    expect(withReadScope(ctx, () => computeCharacteristics(ctx, perm).power, stale)).toBe(4);
  });

  it('layer-read-scope-resume-strict — a strict game throws on resuming a changed state', () => {
    const ctx = game();
    ctx.strictInvariants = true;
    const perm = spawn(ctx, 'P1', bear());
    withReadScope(ctx, () => computeCharacteristics(ctx, perm));
    const board = lastReadScope(ctx);
    perm.counters['+1/+1'] = 1;
    expect(() => withReadScope(ctx, () => computeCharacteristics(ctx, perm), board)).toThrow(
      /layer input changed inside a read scope/,
    );
  });
});
