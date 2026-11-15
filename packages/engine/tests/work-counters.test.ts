/**
 * The engine work counters (`engineWork`) make small CPU wins provable: a count repeats exactly
 * where a timing moves 15-30% between runs. These tests pin what each counter counts, that the
 * cache checks do not count, and that no rule can read them, so counting can never change a game.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { computeAllCharacteristics } from '../src/effects/continuous';
import { digestOf } from '../src/effects/layer-cache';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { engineWork, engineWorkSince, type EngineWork } from '../src/work-counters';
import { conjure, copies, forest, gameConfig, oracle, spawn } from './fixtures';

/** P1 in their main phase with a {2} sorcery, a Forest and a rock whose output is stateful. */
function game(strictInvariants = false): { ctx: GameContext; spell: string } {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      strictInvariants ? { strictInvariants: true } : {},
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const spell = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Two-Mana Sorcery',
      typeLine: 'Sorcery',
      manaCost: '{2}',
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  const rock = spawn(
    ctx,
    'P1',
    oracle({ name: 'Counting Rock', typeLine: 'Artifact', oracleText: '{T}: Add {C}.' }),
  );
  // An amount on a mana ability makes its production state-dependent: the stateful planner.
  ctx.defs.set(rock.oracleId, {
    ...ctx.defs.get(rock.oracleId)!,
    manaAbilities: [{ units: [['C']], amount: { kind: 'const', n: 1 } }],
  });
  spawn(ctx, 'P1', forest());
  return { ctx, spell: spell.id };
}

const castable = (ctx: GameContext, objectId: string): boolean =>
  computePriorityOptions(ctx, playerById(ctx, 'P1')).some((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });

function measured<T>(work: () => T): { result: T; work: EngineWork } {
  const before = engineWork();
  const result = work();
  return { result, work: engineWorkSince(before) };
}

describe('engine work counters', () => {
  it('work-counters-layer — a layer pass on a miss, a cache hit and one digest per query after', () => {
    const { ctx } = game();
    const first = measured(() => computeAllCharacteristics(ctx));
    expect(first.work.layerPasses).toBe(1);
    expect(first.work.layerDigests).toBeGreaterThanOrEqual(1);

    const again = measured(() => computeAllCharacteristics(ctx));
    expect(again.result).toBe(first.result);
    expect(again.work).toMatchObject({ layerPasses: 0, layerCacheHits: 1, layerDigests: 1 });

    // A change the layer pass reads is a miss.
    spawn(ctx, 'P1', forest());
    expect(measured(() => computeAllCharacteristics(ctx)).work.layerPasses).toBe(1);
  });

  it('work-counters-planner — the stateful planner counts its searches, states and copies', () => {
    const { ctx, spell } = game();
    const { result, work } = measured(() => castable(ctx, spell));
    expect(result).toBe(true);
    expect(work.castPreviews).toBeGreaterThanOrEqual(1);
    expect(work.manaPlannerSearches).toBeGreaterThanOrEqual(1);
    expect(work.manaPlannerStates).toBeGreaterThanOrEqual(work.manaPlannerSearches);
    // Every visited state is a copy of the game, and so is every activation it tries.
    expect(work.stateCopies).toBeGreaterThanOrEqual(work.manaPlannerStates);
  });

  it('work-counters-exact — the same work counts the same, and cache checks are not counted', () => {
    const plain = game();
    const strict = game(true);
    const run = (ctx: GameContext, spell: string): EngineWork =>
      measured(() => {
        // Enough cache hits that strictInvariants samples (one in 64) recompute several.
        for (let round = 0; round < 200; round++) computeAllCharacteristics(ctx);
        castable(ctx, spell);
      }).work;
    const twin = game();
    const counted = run(plain.ctx, plain.spell);
    expect(run(twin.ctx, twin.spell)).toEqual(counted);
    expect(run(strict.ctx, strict.spell)).toEqual(counted);
  });

  it('work-counters-history — a game digests the same however many games the process ran before', () => {
    // The layer digest numbers definition objects. Numbered process-wide, an identical game
    // digested differently after other games, so which states shared a digest, and the work
    // counted, changed between repeats of the same benchmark.
    const digest = (): number => {
      const { ctx } = game();
      computeAllCharacteristics(ctx);
      return digestOf(ctx, undefined, true);
    };
    const first = digest();
    for (let other = 0; other < 3; other++) computeAllCharacteristics(game().ctx);
    expect(digest()).toBe(first);
  });

  it('work-counters-write-only — no engine code reads the counters, so they cannot change play', () => {
    const src = join(__dirname, '../src');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
      });
    const readers = files(src).filter((path) => {
      const rel = relative(src, path);
      if (rel === 'work-counters.ts' || rel === 'index.ts') return false;
      const text = readFileSync(path, 'utf8');
      const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[./]+work-counters'/g)];
      return imports.some((match) =>
        match[1]!.split(',').some((name) => name.trim() !== 'countWork'),
      );
    });
    expect(readers).toEqual([]);
  });
});
