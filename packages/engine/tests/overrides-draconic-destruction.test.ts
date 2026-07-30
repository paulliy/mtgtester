/**
 * Behavioral tests for the Draconic Destruction precon's authored overrides
 * (`packages/engine/src/cards/overrides/draconic-destruction.ts`, ADR 0009/0010).
 *
 * Each `describe` block pins one card's actual mechanical behavior — never just
 * `modeled === true` (the overrides module comment's rule 3).
 */

import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
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
