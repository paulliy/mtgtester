/**
 * +1/+1 counters: placement primitives feeding CR 613 layer 7c, and the CR 614.1c
 * enters-with-counters replacement effect.
 *
 * The layer engine and the CR 704.5r annihilation SBA already existed; what these tests guard
 * is that counters get *placed* correctly and that "enters with counters" is a replacement
 * rather than a trigger — the difference is a 0/0 that lives versus one that dies on arrival.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { queueTriggersForObject } from '../src/state/objects';
import { effectivePT } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { runTurn } from '../src/turn/turn';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function ctx4(seed = 'counters'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(2, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 2;
  for (const p of ctx.state.players) {
    conjure(ctx, p.id, forest(), 'library');
    conjure(ctx, p.id, forest(), 'library');
  }
  return ctx;
}

describe('counter placement', () => {
  it('parses "put a +1/+1 counter on target creature"', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Mentor',
        typeLine: 'Creature — Test Soldier',
        manaCost: '{1}{W}',
        power: '2',
        toughness: '2',
        oracleText:
          'When Test Mentor enters the battlefield, put two +1/+1 counters on target creature.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.targets).toEqual([{ kind: 'creature' }]);
    expect(def.triggers[0]?.effects).toEqual([
      { op: 'putCounters', target: 0, counter: '+1/+1', count: 2 },
    ]);
  });

  it('parses "put a +1/+1 counter on ~" as a self-selector, allocating no target', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Grower',
        typeLine: 'Creature — Test Hydra',
        manaCost: '{1}{G}',
        power: '1',
        toughness: '1',
        oracleText: 'At the beginning of your upkeep, put a +1/+1 counter on Test Grower.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.targets).toEqual([]);
    expect(def.triggers[0]?.effects).toEqual([
      { op: 'putCountersEach', selector: { kind: 'self' }, counter: '+1/+1', count: 1 },
    ]);
  });

  it('places counters on a target and layer 7c reflects them immediately', () => {
    const ctx = ctx4();
    const target = spawn(ctx, 'P2', bear()); // 2/2
    const mentorCard = oracle({
      name: 'Test Mentor',
      typeLine: 'Creature — Test Soldier',
      power: '2',
      toughness: '2',
      oracleText:
        'When Test Mentor enters the battlefield, put two +1/+1 counters on target creature.',
    });
    // Queued without spawning the source, so the bear is the only legal target.
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: 'test-mentor-card',
      sourceOracleId: mentorCard.oracleId,
      sourceName: mentorCard.name,
      ability: interpretCard(mentorCard).triggers[0]!,
    });

    pump(runTurn(ctx));

    expect(target.counters['+1/+1']).toBe(2);
    expect(effectivePT(ctx, target)).toEqual({ power: 4, toughness: 4 });
  });

  it('places counters on itself via the self selector', () => {
    const ctx = ctx4();
    const grower = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Grower',
        typeLine: 'Creature — Test Hydra',
        power: '1',
        toughness: '1',
        oracleText: 'When Test Grower enters the battlefield, put three +1/+1 counters on Test Grower.',
      }),
    );
    queueTriggersForObject(ctx, 'enters', grower);

    pump(runTurn(ctx));

    expect(grower.counters['+1/+1']).toBe(3);
    expect(effectivePT(ctx, grower)).toEqual({ power: 4, toughness: 4 });
  });
});

describe('enters with counters (CR 614.1c replacement)', () => {
  const hydra = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Zero Hydra',
      typeLine: 'Creature — Test Hydra',
      manaCost: '{2}{G}',
      power: '0',
      toughness: '0',
      oracleText: 'Test Zero Hydra enters the battlefield with three +1/+1 counters on it.',
    });

  it('parses into entersWithCounters, not into a trigger', () => {
    const def = interpretCard(hydra());
    expect(def.modeled).toBe(true);
    expect(def.entersWithCounters).toEqual({ '+1/+1': 3 });
    expect(def.triggers).toEqual([]);
  });

  it('a 0/0 that enters with counters SURVIVES — it is never momentarily 0-toughness', () => {
    // This is the whole reason it is a replacement effect. Modeled as a trigger, the creature
    // would enter as a 0/0 and die to CR 704.5f before the trigger could resolve.
    const ctx = ctx4();
    const perm = spawn(ctx, 'P1', hydra());

    expect(perm.counters['+1/+1']).toBe(3);
    expect(effectivePT(ctx, perm)).toEqual({ power: 3, toughness: 3 });

    pump(runTurn(ctx));
    expect(ctx.state.battlefield.some((p) => p.id === perm.id)).toBe(true);
  });
});
