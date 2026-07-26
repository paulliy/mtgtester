/**
 * Triggered abilities (brief §5.5): same-controller simultaneous triggers are ordered by
 * that player (an AI decision); different controllers' triggers stack in APNAP order
 * (active player's first ⇒ non-active player's resolves first). Optional "you may"
 * triggers ask on resolution.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { queueTriggersForObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { runTurn } from '../src/turn/turn';
import { bear, conjure, copies, forest, gameConfig, oracle, pick, pump, spawn } from './fixtures';

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

/**
 * CR 603.3d: a triggered ability's targets are chosen as it is PUT ON THE STACK, not when it
 * resolves — and an ability whose targets cannot be chosen is removed from the stack rather
 * than fizzling later. The three paths below are the whole rule.
 */
describe('targeted triggered abilities (CR 603.3d)', () => {
  const etbSlayer = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Slayer',
      typeLine: 'Creature — Test Assassin',
      manaCost: '{2}{B}',
      power: '2',
      toughness: '2',
      oracleText: 'When Test Slayer enters the battlefield, destroy target creature.',
    });

  it('parses a trigger that declares a target', () => {
    const def = interpretCard(etbSlayer());
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.targets).toEqual([{ kind: 'creature' }]);
    expect(def.triggers[0]?.effects).toEqual([{ op: 'destroy', target: 0 }]);
  });

  it('surfaces a target choice when several are legal, and destroys the chosen one', () => {
    const ctx = ctx4();
    const decoy = spawn(ctx, 'P2', bear());
    const victim = spawn(
      ctx,
      'P2',
      oracle({ name: 'Test Victim', typeLine: 'Creature — Test Ox', power: '3', toughness: '3' }),
    );
    const slayer = spawn(ctx, 'P1', etbSlayer());
    queueTriggersForObject(ctx, 'enters', slayer);

    const { decisions } = pump(runTurn(ctx), (d) => {
      if (d.decisionType === 'chooseTargets') {
        return { index: 0, targets: new Map([[0, victim.id]]) };
      }
      return { index: 0, targets: new Map() };
    });

    expect(decisions.some((d) => d.decisionType === 'chooseTargets')).toBe(true);
    expect(ctx.state.battlefield.some((p) => p.id === victim.id)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.id === decoy.id)).toBe(true);
  });

  it('auto-resolves the choice when only one target is legal (no AI call — brief §5.1)', () => {
    const ctx = ctx4();
    const only = spawn(ctx, 'P2', bear());
    // The trigger is queued without putting its source on the battlefield, so the bear is the
    // ONLY creature — a slayer permanent would itself be a second legal target.
    const slayerCard = etbSlayer();
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: 'test-slayer-card',
      sourceOracleId: slayerCard.oracleId,
      sourceName: slayerCard.name,
      ability: interpretCard(slayerCard).triggers[0]!,
    });

    const { decisions } = pump(runTurn(ctx));

    expect(decisions.some((d) => d.decisionType === 'chooseTargets')).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.id === only.id)).toBe(false);
  });

  it('removes the trigger from the stack when no legal target exists', () => {
    const ctx = ctx4();
    // A creature-less battlefield: the slayer itself is never spawned, so "target creature"
    // has no candidates at all and the ability never arrives (CR 603.3d).
    const slayerCard = etbSlayer();
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: 'test-slayer-card',
      sourceOracleId: slayerCard.oracleId,
      sourceName: slayerCard.name,
      ability: interpretCard(slayerCard).triggers[0]!,
    });

    const { decisions } = pump(runTurn(ctx));

    expect(decisions.some((d) => d.decisionType === 'chooseTargets')).toBe(false);
    expect(ctx.state.eventLog.some((e) => e.type === 'triggerRemovedNoTargets')).toBe(true);
    expect(ctx.state.eventLog.some((e) => e.type === 'triggerOnStack')).toBe(false);
  });

  it('fizzles when the chosen target becomes illegal before resolution (CR 608.2b)', () => {
    const ctx = ctx4();
    const victim = spawn(ctx, 'P2', bear());
    const slayer = spawn(ctx, 'P1', etbSlayer());
    queueTriggersForObject(ctx, 'enters', slayer);

    // Remove the target in response — after it was chosen, before the trigger resolves.
    const gen = runTurn(ctx);
    let step = gen.next();
    while (step.done !== true) {
      if (step.value.decisionType === 'chooseTargets') {
        step = gen.next({ index: 0, targets: new Map([[0, victim.id]]) });
        ctx.state.battlefield = ctx.state.battlefield.filter((p) => p.id !== victim.id);
        continue;
      }
      step = gen.next({ index: 0, targets: new Map() });
    }

    expect(ctx.state.eventLog.some((e) => e.type === 'fizzle')).toBe(true);
  });
});
