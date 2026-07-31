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
import {
  bear,
  bolt,
  conjure,
  copies,
  forest,
  gameConfig,
  mountain,
  oracle,
  pick,
  pump,
  spawn,
} from './fixtures';

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

  /**
   * F6-style yield is a STOP LIST, not "any opponent action" (brief — player-experience
   * overhaul, Workstream 2): it survives an opponent's action unless that action targets the
   * yielding player, threatens their board, or threatens their life/hand. Otherwise a
   * developed four-player board — full of triggers — breaks every yield within a step.
   */
  it('survives an opponent spell that targets someone else', () => {
    const ctx = boltContext();
    let p2Yielded = false;

    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1') {
        const opt = d.options.findIndex((o) => o.description.includes('Cast Test Bolt'));
        if (opt >= 0) return { index: opt, targets: new Map([[0, 'P4']]) };
      }
      if (d.player === 'P2' && !p2Yielded) {
        p2Yielded = true;
        const opt = d.options.findIndex((o) => o.type === 'passAndYieldTurn');
        return { index: opt, targets: new Map() };
      }
      const passOpt = d.options.findIndex((o) => o.type === 'pass');
      return { index: passOpt >= 0 ? passOpt : 0, targets: new Map() };
    });

    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    expect(p2Yielded).toBe(true);
    // P1's bolt at P4 is not a stop for P2 — it neither targets P2 nor touches P2's board.
    expect(p2?.yieldUntilEndOfTurn).toBe(true);
  });

  it('breaks when a spell targets the yielding player', () => {
    const ctx = boltContext();

    // Phase 1: P2 yields on an uneventful priority sequence.
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P2') return pick(d, 'yield until end of turn');
      return pick(d, 'Pass priority');
    });
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (!p2) throw new Error('no P2');
    expect(p2.yieldUntilEndOfTurn).toBe(true);

    // Phase 2: P1 casts a fresh bolt, this time targeting P2.
    conjure(ctx, 'P1', bolt(), 'hand');
    spawn(ctx, 'P1', mountain());
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1') {
        const opt = d.options.findIndex((o) => o.description.includes('Cast Test Bolt'));
        if (opt >= 0) return { index: opt, targets: new Map([[0, 'P2']]) };
      }
      return pick(d, 'Pass priority');
    });

    expect(p2.yieldUntilEndOfTurn).toBe(false);
  });

  it('breaks when a spell targets a permanent the yielding player controls', () => {
    const ctx = boltContext();

    // Phase 1: P2 yields on an uneventful priority sequence.
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P2') return pick(d, 'yield until end of turn');
      return pick(d, 'Pass priority');
    });
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (!p2) throw new Error('no P2');
    expect(p2.yieldUntilEndOfTurn).toBe(true);

    // Phase 2: P1 bolts P2's creature, not P2 directly.
    const p2Bear = spawn(ctx, 'P2', bear());
    conjure(ctx, 'P1', bolt(), 'hand');
    spawn(ctx, 'P1', mountain());
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1') {
        const opt = d.options.findIndex((o) => o.description.includes('Cast Test Bolt'));
        if (opt >= 0) return { index: opt, targets: new Map([[0, p2Bear.id]]) };
      }
      return pick(d, 'Pass priority');
    });

    expect(p2.yieldUntilEndOfTurn).toBe(false);
  });

  it('breaks when a mass effect would hit the yielding player\'s board', () => {
    const ctx = boltContext();

    // Phase 1: P2 yields on an uneventful priority sequence.
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P2') return pick(d, 'yield until end of turn');
      return pick(d, 'Pass priority');
    });
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (!p2) throw new Error('no P2');
    expect(p2.yieldUntilEndOfTurn).toBe(true);

    // Phase 2: P2 develops a board, then P1 wraths. Generic-only cost — the fixture's mana
    // base is red (`mountain`), so a colored cost here would leave the cast illegal to offer.
    spawn(ctx, 'P2', bear());
    conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Wrath',
        typeLine: 'Sorcery',
        manaCost: '{3}',
        oracleText: 'Destroy all creatures.',
      }),
      'hand',
    );
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', mountain());
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1') {
        const opt = d.options.findIndex((o) => o.description.includes('Cast Test Wrath'));
        if (opt >= 0) return { index: opt, targets: new Map() };
      }
      return pick(d, 'Pass priority');
    });

    expect(p2.yieldUntilEndOfTurn).toBe(false);
  });

  it('survives an opponent spell that only threatens their own board', () => {
    const ctx = boltContext();

    // Phase 1: P2 yields on an uneventful priority sequence.
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P2') return pick(d, 'yield until end of turn');
      return pick(d, 'Pass priority');
    });
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (!p2) throw new Error('no P2');
    expect(p2.yieldUntilEndOfTurn).toBe(true);

    // Phase 2: P1 wraths their OWN board only — not a stop for P2. Generic-only cost, same
    // reason as the mass-wrath test above.
    spawn(ctx, 'P1', bear());
    conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Self Wrath',
        typeLine: 'Sorcery',
        manaCost: '{2}',
        oracleText: 'Destroy all creatures you control.',
      }),
      'hand',
    );
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', mountain());
    let p1Cast = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (d.player === 'P1') {
        const opt = d.options.findIndex((o) => o.description.includes('Cast Test Self Wrath'));
        if (opt >= 0) {
          p1Cast = true;
          return { index: opt, targets: new Map() };
        }
      }
      return pick(d, 'Pass priority');
    });

    expect(p1Cast).toBe(true);
    expect(p2.yieldUntilEndOfTurn).toBe(true);
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
