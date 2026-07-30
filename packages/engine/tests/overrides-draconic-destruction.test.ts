/**
 * Behavioral tests for the Draconic Destruction precon's authored overrides
 * (`packages/engine/src/cards/overrides/draconic-destruction.ts`, ADR 0009/0010).
 *
 * Each `describe` block pins one card's actual mechanical behavior — never just
 * `modeled === true` (the overrides module comment's rule 3).
 */

import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
import { endUntilEotEffects } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { runPrioritySequence } from '../src/turn/priority';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { conjure, forest, copies, gameConfig, mountain, oracle, pump, spawn } from './fixtures';

function pod(seed = 'draconic-destruction-overrides'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const handSize = (ctx: GameContext, id: string): number =>
  ctx.state.players.find((p) => p.id === id)?.hand.length ?? 0;

/** Declare every eligible attacker against P2 and run combat to completion. */
function attackAll(ctx: GameContext): void {
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  pump(runCombatPhase(ctx), (d) => {
    const all = d.options.findIndex((o) => o.description.includes('undeclared creatures'));
    if (all >= 0 && d.options[all]?.description.includes('P2') === true) {
      return { index: all, targets: new Map() };
    }
    const one = d.options.findIndex((o) => /attacks P2/.test(o.description));
    if (one >= 0) return { index: one, targets: new Map() };
    return { index: 0, targets: new Map() };
  });
}

describe('Dragon Mage', () => {
  const dragonMage = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Dragon Mage',
      oracleId: 'oracle-dragon-mage',
      typeLine: 'Creature — Dragon Wizard',
      manaCost: '{5}{R}{R}',
      power: '5',
      toughness: '5',
      oracleText:
        'Flying\nWhenever Dragon Mage deals combat damage to a player, each player discards their hand, then draws seven cards.',
    });

  it('when it connects, every player discards their hand and draws seven', () => {
    const ctx = pod();
    spawn(ctx, 'P1', dragonMage());

    // Fill every hand with a few library-backed cards so "discard hand" has something in it,
    // and enough library so seven-card draws don't hit an empty deck.
    for (const p of ctx.state.players) {
      for (let i = 0; i < 3; i++) conjure(ctx, p.id, forest(), 'hand');
      for (let i = 0; i < 10; i++) conjure(ctx, p.id, forest(), 'library');
    }
    const handsBefore = ctx.state.players.map((p) => handSize(ctx, p.id));
    expect(handsBefore.every((n) => n === 3)).toBe(true);

    attackAll(ctx);

    for (const p of ctx.state.players) {
      expect(handSize(ctx, p.id)).toBe(7);
    }
    // The three original hand cards were discarded, not drawn back into a fresh top-of-library.
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    expect(p1.graveyard.length).toBe(3);
  });
});

describe('Dream Pillager', () => {
  const dreamPillager = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Dream Pillager',
      oracleId: 'oracle-dream-pillager',
      typeLine: 'Creature — Dragon',
      manaCost: '{5}{R}{R}',
      power: '4',
      toughness: '4',
      oracleText:
        'Flying\nWhenever Dream Pillager deals combat damage to a player, exile that many cards from the top of your library. Until end of turn, you may cast spells from among those exiled cards.',
    });

  const testShock = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Shock',
      typeLine: 'Instant',
      manaCost: '{R}',
      power: null,
      toughness: null,
      oracleText: 'Test Shock deals 2 damage to any target.',
    });

  it('exiles cards equal to the damage dealt and lets its controller cast one of them', () => {
    const ctx = pod();
    spawn(ctx, 'P1', dreamPillager());
    spawn(ctx, 'P1', mountain());
    // `conjure(..., 'library')` unshifts, so the LAST card conjured ends up on top.
    for (let i = 0; i < 5; i++) conjure(ctx, 'P1', forest(), 'library');
    const shock = conjure(ctx, 'P1', testShock(), 'library');

    attackAll(ctx);

    // Exactly 4 cards (Dream Pillager's power) came off the top of the library into exile,
    // playable by P1 until end of turn — starting with the Shock that was on top.
    expect(ctx.state.exile.filter((c) => c.playableUntilEotBy === 'P1')).toHaveLength(4);
    expect(ctx.state.exile.some((c) => c.cardId === shock.cardId)).toBe(true);

    const p2Before = ctx.state.players.find((p) => p.id === 'P2')?.life;
    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Cast Test Shock'));
      if (i < 0) return { index: 0, targets: new Map() };
      const slot = d.options[i]?.targets?.[0];
      const target = slot?.options.find((o) => o === 'P2');
      return { index: i, targets: new Map(target === undefined ? [] : [[0, target]]) };
    });

    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe((p2Before ?? 0) - 2);
    // Cast from exile, then resolved to the graveyard like any other instant.
    expect(ctx.state.exile.some((c) => c.cardId === shock.cardId)).toBe(false);
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    expect(p1.graveyard.some((c) => c.cardId === shock.cardId)).toBe(true);
  });

  it('the grant expires at cleanup, and the cards stay in exile unplayable', () => {
    const ctx = pod();
    spawn(ctx, 'P1', dreamPillager());
    spawn(ctx, 'P1', mountain());
    // `conjure(..., 'library')` unshifts, so the LAST card conjured ends up on top.
    for (let i = 0; i < 5; i++) conjure(ctx, 'P1', forest(), 'library');
    const shock = conjure(ctx, 'P1', testShock(), 'library');

    attackAll(ctx);
    expect(ctx.state.exile.find((c) => c.cardId === shock.cardId)?.playableUntilEotBy).toBe('P1');

    // Simulate the cleanup sweep directly rather than driving a full extra turn.
    endUntilEotEffects(ctx);

    const stillExiled = ctx.state.exile.find((c) => c.cardId === shock.cardId);
    expect(stillExiled).toBeDefined();
    expect(stillExiled?.playableUntilEotBy).toBeUndefined();
  });
});

describe('Runehorn Hellkite', () => {
  const runehornHellkite = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Runehorn Hellkite',
      oracleId: 'oracle-runehorn-hellkite',
      typeLine: 'Creature — Dragon',
      manaCost: '{4}{R}{R}',
      power: '5',
      toughness: '5',
      oracleText:
        'Flying\n{5}{R}, Exile this card from your graveyard: Each player discards their hand, then draws seven cards.',
    });

  it('exiling it from the graveyard wheels every hand', () => {
    const ctx = pod();
    for (let i = 0; i < 6; i++) spawn(ctx, 'P1', mountain());
    const inGrave = conjure(ctx, 'P1', runehornHellkite(), 'graveyard');

    for (const p of ctx.state.players) {
      for (let i = 0; i < 3; i++) conjure(ctx, p.id, forest(), 'hand');
      for (let i = 0; i < 10; i++) conjure(ctx, p.id, forest(), 'library');
    }

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('discards their hand'));
      return { index: i >= 0 ? i : 0, targets: new Map() };
    });

    for (const p of ctx.state.players) {
      expect(p.hand.length).toBe(7);
    }
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    // Paid for by exiling itself from the graveyard, not left sitting there or destroyed again.
    expect(p1.graveyard.some((c) => c.cardId === inGrave.cardId)).toBe(false);
    expect(ctx.state.exile.some((c) => c.cardId === inGrave.cardId)).toBe(true);
  });
});

describe('Spit Flame', () => {
  const spitFlame = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Spit Flame',
      oracleId: 'oracle-spit-flame',
      typeLine: 'Instant',
      manaCost: '{2}{R}',
      power: null,
      toughness: null,
      oracleText:
        'Spit Flame deals 4 damage to target creature.\nWhenever a Dragon you control enters, you may pay {R}. If you do, return this card from your graveyard to your hand.',
    });

  const dragon = (): ReturnType<typeof oracle> =>
    oracle({ name: 'Test Whelp', typeLine: 'Creature — Dragon', manaCost: '{4}{R}', power: '5', toughness: '5' });

  it('returns itself from the graveyard when its controller pays {R} as a Dragon enters', () => {
    const ctx = pod();
    spawn(ctx, 'P1', mountain());
    const inGrave = conjure(ctx, 'P1', spitFlame(), 'graveyard');
    const whelp = conjure(ctx, 'P1', dragon(), 'hand');

    pump(moveObject(ctx, whelp, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.type === 'payMana');
      return { index: i >= 0 ? i : 0, targets: new Map() };
    });

    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    expect(p1.graveyard.some((c) => c.cardId === inGrave.cardId)).toBe(false);
    expect(p1.hand.some((c) => c.cardId === inGrave.cardId)).toBe(true);
  });

  it('declining the payment leaves it in the graveyard', () => {
    const ctx = pod();
    spawn(ctx, 'P1', mountain());
    const inGrave = conjure(ctx, 'P1', spitFlame(), 'graveyard');
    const whelp = conjure(ctx, 'P1', dragon(), 'hand');

    pump(moveObject(ctx, whelp, { zone: 'battlefield', controllerId: 'P1' }));

    pump(runPrioritySequence(ctx), (d) => {
      const decline = d.options.findIndex((o) => o.type === 'decline');
      return { index: decline >= 0 ? decline : 0, targets: new Map() };
    });

    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    expect(p1.graveyard.some((c) => c.cardId === inGrave.cardId)).toBe(true);
  });
});
