/**
 * Priority and APNAP (brief §5.4, CR 117): full four-player rounds, caster-retains-
 * priority (CR 117.3c), and the all-pass ⇒ resolve / step-end transitions — exercised by
 * driving `runPrioritySequence` directly over surgically built states.
 */

import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@mtg/shared';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { bolt, conjure, copies, forest, gameConfig, mountain, pick, pump, spawn } from './fixtures';

/** A 4-player context in P1's precombat main with everyone holding a castable bolt. */
function boltContext(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'priority' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  for (const p of ctx.state.players) {
    spawn(ctx, p.id, mountain());
    conjure(ctx, p.id, bolt(), 'hand');
    // Libraries so nobody deck-outs during the test.
    conjure(ctx, p.id, forest(), 'library');
  }
  return ctx;
}

describe('priority and APNAP (brief §5.4)', () => {
  it('offers priority in APNAP order and ends the step after all pass', () => {
    const ctx = boltContext();
    const order: PlayerId[] = [];
    pump(runPrioritySequence(ctx), (d) => {
      order.push(d.player);
      return pick(d, 'Pass');
    });
    // Every player had a real option (cast bolt) — all four surfaced, in APNAP order.
    expect(order).toEqual(['P1', 'P2', 'P3', 'P4']);
  });

  it('a player who casts a spell retains priority (CR 117.3c)', () => {
    const ctx = boltContext();
    // P2 gets a second bolt + mountain so their retained priority window is visible
    // (with an empty hand it would be auto-passed).
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (p2 === undefined) throw new Error('no P2');
    spawn(ctx, 'P2', mountain());
    conjure(ctx, 'P2', bolt(), 'hand');

    const order: PlayerId[] = [];
    let cast = false;
    pump(runPrioritySequence(ctx), (d) => {
      order.push(d.player);
      if (d.player === 'P2' && !cast) {
        cast = true;
        const opt = d.options.findIndex((o) => o.description.includes('Cast Test Bolt'));
        const slot = d.options[opt]?.targets?.[0];
        return { index: opt, targets: new Map([[0, slot?.options[0] as string]]) };
      }
      return pick(d, 'Pass');
    });
    // P1 passes, P2 casts and IMMEDIATELY receives priority again (before P3).
    expect(order.slice(0, 3)).toEqual(['P1', 'P2', 'P2']);
  });

  it('resolution requires all four players to pass in succession, then AP gets priority', () => {
    const ctx = boltContext();
    const p3 = ctx.state.players.find((p) => p.id === 'P3');
    const startingLife = p3?.life ?? 0;
    const sequence: string[] = [];
    let cast = false;
    pump(runPrioritySequence(ctx), (d) => {
      sequence.push(d.player);
      if (d.player === 'P1' && !cast) {
        cast = true;
        const opt = d.options.findIndex((o) => o.description.includes('Cast Test Bolt'));
        return { index: opt, targets: new Map([[0, 'P3']]) };
      }
      return pick(d, 'Pass');
    });
    // P1 casts (then auto-passes: empty hand), P2–P4 get response windows; all pass in
    // succession → the bolt resolves → priority reopens from the AP (P1 auto-passes
    // again) and P2–P4 are surfaced once more on the empty stack.
    expect(sequence).toEqual(['P1', 'P2', 'P3', 'P4', 'P2', 'P3', 'P4']);
    expect(p3?.life).toBe(startingLife - 3);
  });

  it('auto-passes players with zero real responses (no decision surfaced)', () => {
    const ctx = boltContext();
    // Take everyone's bolts away except P4's: P1 (AP) has no plays either.
    for (const p of ctx.state.players) {
      if (p.id !== 'P4') p.hand = [];
    }
    const surfaced: PlayerId[] = [];
    pump(runPrioritySequence(ctx), (d) => {
      surfaced.push(d.player);
      return pick(d, 'Pass');
    });
    expect(surfaced).toEqual(['P4']);
  });
});

describe('MTGO-style yield actions (F6)', () => {
  it('auto-passes priority when player chooses "Pass and yield until end of turn"', () => {
    const ctx = boltContext();
    const sequence: PlayerId[] = [];
    let p2Yielded = false;

    pump(runPrioritySequence(ctx), (d) => {
      sequence.push(d.player);
      if (d.player === 'P2' && !p2Yielded) {
        p2Yielded = true;
        const opt = d.options.findIndex((o) => o.type === 'passAndYieldTurn');
        return { index: opt, targets: new Map() };
      }
      return pick(d, 'Pass');
    });

    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    expect(p2?.yieldUntilEndOfTurn).toBe(true);
    expect(sequence).toEqual(['P1', 'P2', 'P3', 'P4']);
  });

  it('breaks "Pass and yield until end of turn" when an opponent casts a spell', () => {
    const ctx = boltContext();
    const sequence: { player: PlayerId; stackLen: number }[] = [];
    let p2Yielded = false;
    let p1CastFirst = false;

    // P2 has a second bolt + mountain so P2 has legal actions
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (!p2) throw new Error('no P2');
    spawn(ctx, 'P2', mountain());
    conjure(ctx, 'P2', bolt(), 'hand');

    pump(runPrioritySequence(ctx), (d) => {
      sequence.push({ player: d.player, stackLen: ctx.state.stack.length });
      if (d.player === 'P1' && !p1CastFirst) {
        p1CastFirst = true;
        const opt = d.options.findIndex((o) => o.description.includes('Cast Test Bolt'));
        return { index: opt, targets: new Map([[0, 'P4']]) };
      }
      if (d.player === 'P2' && !p2Yielded) {
        p2Yielded = true;
        const opt = d.options.findIndex((o) => o.type === 'passAndYieldTurn');
        return { index: opt, targets: new Map() };
      }
      const passOpt = d.options.findIndex((o) => o.type === 'pass');
      return { index: passOpt >= 0 ? passOpt : 0, targets: new Map() };
    });

    expect(p2Yielded).toBe(true);
    // P2 yielded turn on the first stack (Bolt 1).
    expect(p2.yieldUntilEndOfTurn).toBe(true);

    // Now P1 casts a SECOND spell on a new priority sequence in the same turn
    conjure(ctx, 'P1', bolt(), 'hand');
    spawn(ctx, 'P1', mountain());
    let p2SurfacedOnSecondSpell = false;

    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1') {
        const opt = d.options.findIndex((o) => o.description.includes('Cast Test Bolt'));
        if (opt >= 0) {
          return { index: opt, targets: new Map([[0, 'P4']]) };
        }
      }
      if (d.player === 'P2') {
        p2SurfacedOnSecondSpell = true;
      }
      const passOpt = d.options.findIndex((o) => o.type === 'pass');
      return { index: passOpt >= 0 ? passOpt : 0, targets: new Map() };
    });

    expect(p2SurfacedOnSecondSpell).toBe(true);
    expect(p2.yieldUntilEndOfTurn).toBe(false);
  });

  it('offers and applies "Yield to this ability" for triggered abilities', () => {
    const ctx = boltContext();
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (!p2) throw new Error('no P2');

    // Give P2 an instant so P2 is not auto-passed by isForced (has real choices)
    spawn(ctx, 'P2', mountain());
    conjure(ctx, 'P2', bolt(), 'hand');

    // Put a triggered ability on the stack from source oracleId 'test-oracle-ram'
    ctx.state.stack.push({
      id: 'o-test-trigger',
      sourceId: 'c-test-ram',
      controllerId: 'P1',
      kind: 'triggeredAbility',
      description: "Nyx-Fleece Ram's upkeep ability",
      targets: [],
      card: null,
      ability: { kind: 'triggered', description: 'gain 1 life', effects: [], targets: [] },
      sourceOracleId: 'test-oracle-ram',
      sourceCardId: 'c-test-ram',
      isCommanderCast: false,
    });

    let p2SawYield = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P2') {
        const yieldOpt = d.options.findIndex((o) => o.type === 'yieldToAbility');
        if (yieldOpt >= 0) {
          p2SawYield = true;
          return { index: yieldOpt, targets: new Map() };
        }
      }
      const passOpt = d.options.findIndex((o) => o.type === 'pass');
      return { index: passOpt >= 0 ? passOpt : 0, targets: new Map() };
    });

    expect(p2SawYield).toBe(true);
    expect(p2.yieldedAbilities).toContain('test-oracle-ram');

    // Put another trigger from the same source on the stack
    ctx.state.stack.push({
      id: 'o-test-trigger-2',
      sourceId: 'c-test-ram',
      controllerId: 'P1',
      kind: 'triggeredAbility',
      description: "Nyx-Fleece Ram's upkeep ability",
      targets: [],
      card: null,
      ability: { kind: 'triggered', description: 'gain 1 life', effects: [], targets: [] },
      sourceOracleId: 'test-oracle-ram',
      sourceCardId: 'c-test-ram',
      isCommanderCast: false,
    });

    const secondSurfaced: { player: PlayerId; stackLen: number }[] = [];
    pump(runPrioritySequence(ctx), (d) => {
      secondSurfaced.push({ player: d.player, stackLen: ctx.state.stack.length });
      const passOpt = d.options.findIndex((o) => o.type === 'pass');
      return { index: passOpt >= 0 ? passOpt : 0, targets: new Map() };
    });

    // P2 yielded to test-oracle-ram: P2 is auto-passed and NOT surfaced while test-oracle-ram trigger is on the stack!
    const surfacedOnTrigger = secondSurfaced
      .filter((entry) => entry.stackLen > 0)
      .map((entry) => entry.player);
    expect(surfacedOnTrigger).not.toContain('P2');
  });
});
