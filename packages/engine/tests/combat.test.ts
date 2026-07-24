/**
 * Combat (brief §5.3/§5.4, CR 506–511): the Giant-Growth-during-blocks worked example
 * end to end, first strike's extra damage step, trample/deathtouch/vigilance/lifelink,
 * flying evasion, and 21 commander damage across multiple combats.
 */

import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
import { GameOverSignal } from '../src/signals';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  bear,
  commanderFor,
  conjure,
  copies,
  forest,
  gameConfig,
  giantGrowth,
  keywordCreature,
  pick,
  pump,
  spawn,
} from './fixtures';

function combatContext(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed: 'combat' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  for (const p of ctx.state.players) {
    conjure(ctx, p.id, forest(), 'library');
  }
  return ctx;
}

const attackWith =
  (name: string, defender: string) => (d: import('../src/decisions').PendingDecision) =>
    d.options.some((o) => o.description.includes(`${name} attacks ${defender}`))
      ? pick(d, `${name} attacks ${defender}`)
      : null;

describe('combat (brief §5.4 worked example and CR 506–511)', () => {
  it('plays the Giant-Growth-during-blocks example end to end', () => {
    const ctx = combatContext();
    const attacker = spawn(ctx, 'P1', bear()); // 2/2
    const blocker = spawn(ctx, 'P2', keywordCreature('Test Bruiser', '', '{2}{W}', '3/3'));
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', giantGrowth(), 'hand');

    let growthCast = false;
    pump(runCombatPhase(ctx), (d) => {
      // Declare the attack.
      const attack = attackWith('Test Bear', 'P2')(d);
      if (attack !== null) return attack;
      // Block with the 3/3.
      if (d.options.some((o) => o.description.includes('Test Bruiser blocks Test Bear'))) {
        return pick(d, 'Test Bruiser blocks Test Bear');
      }
      // Blockers declared, priority reopens: P1 (active player) pumps the 2/2 to 5/5.
      if (
        d.player === 'P1' &&
        !growthCast &&
        ctx.state.step === 'declareBlockers' &&
        d.options.some((o) => o.description.includes('Test Growth'))
      ) {
        growthCast = true;
        const idx = d.options.findIndex((o) => o.description.includes('Test Growth'));
        return { index: idx, targets: new Map([[0, attacker.id]]) };
      }
      return pick(d, /Pass|does not/);
    });

    expect(growthCast).toBe(true);
    // 5/5 attacker beat the 3/3 blocker and survived its 3 damage (5 toughness).
    expect(ctx.state.battlefield.find((p) => p.id === blocker.id)).toBeUndefined();
    const survivor = ctx.state.battlefield.find((p) => p.cardId === attacker.cardId);
    expect(survivor).toBeDefined();
    // No damage went through to the defending player.
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(40);
  });

  it('first strike creates a second damage step and kills before counterattack', () => {
    const ctx = combatContext();
    const duelist = spawn(ctx, 'P1', keywordCreature('Test Duelist', 'First strike', '{W}', '2/2'));
    const victim = spawn(ctx, 'P2', keywordCreature('Test Victim', '', '{1}', '2/2'));

    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Duelist', 'P2')(d);
      if (attack !== null) return attack;
      if (d.options.some((o) => o.description.includes('Test Victim blocks'))) {
        return pick(d, 'Test Victim blocks');
      }
      return pick(d, /Pass|does not/);
    });

    // Both damage steps happened; the victim died in the first-strike step and never
    // dealt its damage back.
    const steps = ctx.state.eventLog
      .filter((e) => e.type === 'combatDamageStep')
      .map((e) => e.payload['step']);
    expect(steps).toEqual(['first', 'regular']);
    expect(ctx.state.battlefield.find((p) => p.id === victim.id)).toBeUndefined();
    const attackerAfter = ctx.state.battlefield.find((p) => p.cardId === duelist.cardId);
    expect(attackerAfter?.damageMarked).toBe(0);
  });

  it('double strike deals damage in both steps (unblocked: twice to the player)', () => {
    const ctx = combatContext();
    spawn(ctx, 'P1', keywordCreature('Test Berserker', 'Double strike', '{R}', '2/2'));

    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Berserker', 'P2')(d);
      if (attack !== null) return attack;
      return pick(d, /Pass|does not/);
    });

    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(36);
  });

  it('trample assigns lethal to the blocker and the rest to the player; deathtouch makes 1 lethal', () => {
    const ctx = combatContext();
    spawn(ctx, 'P1', keywordCreature('Test Crusher', 'Trample, deathtouch', '{3}{G}', '4/4'));
    spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '3/3'));

    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Crusher', 'P2')(d);
      if (attack !== null) return attack;
      if (d.options.some((o) => o.description.includes('Test Wall blocks'))) {
        return pick(d, 'Test Wall blocks');
      }
      return pick(d, /Pass|does not/);
    });

    // Deathtouch: 1 damage is lethal to the 3/3; remaining 3 tramples through.
    expect(ctx.state.battlefield.find((p) => p.name === 'Test Wall')).toBeUndefined();
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(37);
  });

  it('vigilance attacks untapped; lifelink heals its controller', () => {
    const ctx = combatContext();
    const paladin = spawn(
      ctx,
      'P1',
      keywordCreature('Test Paladin', 'Vigilance, lifelink', '{1}{W}', '2/2'),
    );
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    if (p1 !== undefined) p1.life = 30;

    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Paladin', 'P3')(d);
      if (attack !== null) return attack;
      return pick(d, /Pass|does not/);
    });

    const after = ctx.state.battlefield.find((p) => p.cardId === paladin.cardId);
    expect(after?.tapped).toBe(false); // vigilance (CR 508.1f exception)
    expect(ctx.state.players.find((p) => p.id === 'P3')?.life).toBe(38);
    expect(p1?.life).toBe(32); // lifelink
  });

  it('flying can only be blocked by flying or reach', () => {
    const ctx = combatContext();
    spawn(ctx, 'P1', keywordCreature('Test Hawk', 'Flying', '{W}', '1/1'));
    spawn(ctx, 'P2', keywordCreature('Test Grounded', '', '{1}', '2/2'));
    spawn(ctx, 'P2', keywordCreature('Test Spider', 'Reach', '{1}{G}', '1/3'));

    const blockDecisions: string[][] = [];
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Hawk', 'P2')(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        blockDecisions.push(d.options.map((o) => o.description));
        return pick(d, 'does not block');
      }
      return pick(d, /Pass|does not/);
    });

    // Only the reach creature was offered the block; the grounded 2/2 was never asked
    // (its only possible block is illegal, so it has no choice to make).
    expect(blockDecisions).toHaveLength(1);
    expect(blockDecisions[0]?.some((desc) => desc.includes('Test Spider blocks'))).toBe(true);
  });

  it('21 combat damage from the same commander eliminates across multiple combats', () => {
    const ctx = combatContext();
    const commander = spawn(ctx, 'P1', commanderFor('G', 'Test General'), { isCommander: true });
    const p2 = ctx.state.players.find((p) => p.id === 'P2');

    let eliminated: GameOverSignal | null = null;
    for (let combatRound = 1; combatRound <= 7; combatRound++) {
      const perm = ctx.state.battlefield.find(
        (p) => p.cardId === commander.cardId,
      ) as EnginePermanent;
      perm.tapped = false;
      try {
        pump(runCombatPhase(ctx), (d) => {
          const attack = attackWith('Test General', 'P2')(d);
          if (attack !== null) return attack;
          return pick(d, /Pass|does not/);
        });
      } catch (err) {
        if (err instanceof GameOverSignal) {
          eliminated = err;
          break;
        }
        throw err;
      }
      expect(p2?.commanderDamageTaken[commander.cardId]).toBe(3 * combatRound);
    }

    // 7 × 3 = 21: P2 is eliminated by commander damage (brief §5.7) mid-combat via SBA;
    // with three players left the game continues (no GameOverSignal).
    expect(eliminated).toBeNull();
    expect(p2?.hasLost).toBe(true);
    expect(p2?.lossReason).toBe('commanderDamage');
    expect(ctx.state.turnOrder).toEqual(['P1', 'P3', 'P4']);
    // Regular (non-commander) damage in the same game did NOT count toward the total —
    // implicitly covered: only commander damage was tracked at all.
  });
});
