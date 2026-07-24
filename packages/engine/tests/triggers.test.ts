/**
 * Triggered abilities (brief §5.5): same-controller simultaneous triggers are ordered by
 * that player (an AI decision); different controllers' triggers stack in APNAP order
 * (active player's first ⇒ non-active player's resolves first). Optional "you may"
 * triggers ask on resolution.
 */

import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { runTurn } from '../src/turn/turn';
import { conjure, copies, forest, gameConfig, oracle, pick, pump, spawn } from './fixtures';

function ctx4(seed = 'triggers'): GameContext {
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

const upkeepShrine = (name: string, life: number): ReturnType<typeof oracle> =>
  oracle({
    name,
    typeLine: 'Enchantment',
    power: null,
    toughness: null,
    oracleText: `At the beginning of your upkeep, you gain ${life} life.`,
  });

describe('triggered abilities (brief §5.5)', () => {
  it('same controller: the player orders simultaneous triggers; last placed resolves first', () => {
    const ctx = ctx4();
    spawn(ctx, 'P1', upkeepShrine('Test Shrine One', 1));
    spawn(ctx, 'P1', upkeepShrine('Test Shrine Two', 2));

    const { decisions } = pump(runTurn(ctx), (d) => {
      if (d.decisionType === 'orderTriggers') {
        // Put Shrine One on the stack first, Shrine Two second (on top).
        return pick(d, 'Test Shrine One');
      }
      return { index: 0, targets: new Map() };
    });

    expect(decisions.some((d) => d.decisionType === 'orderTriggers')).toBe(true);
    const resolved = ctx.state.eventLog
      .filter((e) => e.type === 'resolved' && String(e.payload['description']).includes('Shrine'))
      .map((e) => String(e.payload['description']));
    // Shrine Two was placed last ⇒ it resolved first (LIFO).
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toContain('Shrine Two');
    expect(resolved[1]).toContain('Shrine One');
    expect(ctx.state.players.find((p) => p.id === 'P1')?.life).toBe(43);
  });

  it('different controllers: APNAP placement, so the non-active player’s resolves first', () => {
    const ctx = ctx4();
    const eachUpkeep = (name: string): ReturnType<typeof oracle> =>
      oracle({
        name,
        typeLine: 'Enchantment',
        power: null,
        toughness: null,
        oracleText: 'At the beginning of each upkeep, you gain 1 life.',
      });
    spawn(ctx, 'P1', eachUpkeep('Test Font Alpha'));
    spawn(ctx, 'P3', eachUpkeep('Test Font Gamma'));

    const { decisions } = pump(runTurn(ctx));
    // One trigger per controller ⇒ no ordering decision for anyone.
    expect(decisions.filter((d) => d.decisionType === 'orderTriggers')).toHaveLength(0);

    const placed = ctx.state.eventLog
      .filter((e) => e.type === 'triggerOnStack')
      .map((e) => String(e.payload['source']));
    const resolved = ctx.state.eventLog
      .filter((e) => e.type === 'resolved' && String(e.payload['description']).includes('Font'))
      .map((e) => String(e.payload['description']));
    // Active player's trigger goes on the stack first (APNAP) — so it resolves LAST.
    expect(placed).toEqual(['Test Font Alpha', 'Test Font Gamma']);
    expect(resolved[0]).toContain('Gamma');
    expect(resolved[1]).toContain('Alpha');
  });

  it('optional ("you may") triggers ask on resolution and can be declined', () => {
    const run = (accept: boolean): { ctx: GameContext; asked: boolean } => {
      const ctx = ctx4(accept ? 'opt-yes' : 'opt-no');
      spawn(
        ctx,
        'P1',
        oracle({
          name: 'Test Oracle Engine',
          typeLine: 'Enchantment',
          power: null,
          toughness: null,
          oracleText: 'At the beginning of your upkeep, you may draw a card.',
        }),
      );
      let asked = false;
      pump(runTurn(ctx), (d) => {
        if (d.decisionType === 'optionalTrigger') {
          asked = true;
          return pick(d, accept ? 'Yes' : 'No');
        }
        return { index: 0, targets: new Map() };
      });
      return { ctx, asked };
    };

    const accepted = run(true);
    expect(accepted.asked).toBe(true);
    // Upkeep draw + regular draw-step draw = 2 draws.
    expect(accepted.ctx.state.eventLog.filter((e) => e.type === 'draw')).toHaveLength(2);

    const declined = run(false);
    expect(declined.asked).toBe(true);
    expect(declined.ctx.state.eventLog.filter((e) => e.type === 'draw')).toHaveLength(1);
    expect(declined.ctx.state.eventLog.some((e) => e.type === 'triggerDeclined')).toBe(true);
  });

  it('an enters-the-battlefield trigger fires when the creature resolves', () => {
    const ctx = ctx4();
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Sage',
        typeLine: 'Creature — Test Wizard',
        manaCost: '{1}{G}',
        power: '1',
        toughness: '1',
        oracleText: 'When Test Sage enters the battlefield, draw a card.',
      }),
      'hand',
    );

    let cast = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (!cast && d.options.some((o) => o.description.includes('Test Sage'))) {
        cast = true;
        return pick(d, 'Test Sage');
      }
      return pick(d, 'Pass');
    });

    expect(ctx.state.battlefield.some((p) => p.name === 'Test Sage')).toBe(true);
    expect(ctx.state.eventLog.some((e) => e.type === 'triggerOnStack')).toBe(true);
    expect(ctx.state.eventLog.filter((e) => e.type === 'draw')).toHaveLength(1);
  });
});
