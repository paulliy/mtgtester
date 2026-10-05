/**
 * Combat (brief §5.3/§5.4, CR 506–511): the Giant-Growth-during-blocks worked example
 * end to end, first strike's extra damage step, trample/deathtouch/vigilance/lifelink,
 * flying evasion, 21 commander damage across multiple combats, and the batched attack/block
 * declarations plus arbitrary combat-damage division (ADR 0023 items 13/14, Phase 4).
 */

import { describe, expect, it } from 'vitest';
import { RandomDecisionProvider } from '../src/providers/providers';
import { describeDamageSplit, runCombatPhase } from '../src/combat/combat';
import { formatSpectatorLog } from '../src/view/spectator';
import { runTurn } from '../src/turn/turn';
import { GameOverSignal } from '../src/signals';
import { createGame } from '../src/state/game';
import type { CardDefinition } from '../src/cards/definition';
import type { PendingDecision } from '../src/decisions';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  bear,
  commanderFor,
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  declareNoAttacks,
  declareNoBlocks,
  forest,
  gameConfig,
  giantGrowth,
  keywordCreature,
  makeEngine,
  oracle,
  pick,
  pump,
  registerCustomDef,
  spawn,
  splitDamage,
} from './fixtures';

/** A Ghostly-Prison-shaped enchantment: "attack tax" on whoever controls it. */
function attackTaxDef(oracleId: string, amount: number): CardDefinition {
  return {
    oracleId,
    name: 'Test Ghostly Prison',
    typeLine: 'Enchantment',
    supertypes: [],
    types: ['Enchantment'],
    subtypes: [],
    colors: [],
    colorIdentity: [],
    manaCost: null,
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    spellAbility: null,
    triggers: [],
    staticEffects: [],
    ruleStatics: [{ kind: 'attackTax', amount }],
    modeled: true,
    unmodeledReasons: [],
  };
}

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

/** Declarations are wiped by end-of-combat cleanup, so assert on the events instead. */
const attackEvents = (ctx: GameContext): GameContext['state']['eventLog'] =>
  ctx.state.eventLog.filter((e) => e.type === 'attack');

/** The batched decision's answer for "only `name` attacks, at `defender`; everyone else stays
 * home" — the shape most single-attacker tests below want (ADR 0023 items 13/14). */
const attackWith = (name: string, defender: string) => (d: PendingDecision) =>
  d.decisionType === 'declareAttackers'
    ? declareAttacks(d, (_id, subject) => (subject.name === name ? defender : null))
    : null;

/** This subject's legal defenders (by seat id), from the batched decision's presentation. */
function subjectDefenders(d: PendingDecision, name: string): string[] {
  const subject = d.presentationAttackDeclaration?.subjects.find((s) => s.name === name);
  return subject?.defenders.map((def) => def.playerId) ?? [];
}
function subjectMustAttack(d: PendingDecision, name: string): boolean {
  return (
    d.presentationAttackDeclaration?.subjects.find((s) => s.name === name)?.mustAttack ?? false
  );
}

/** The batched blocker decision's answer for "only `name` blocks `attackerId`; everyone else
 * stays back" (ADR 0023 Phase 4) — the shape most single-blocker tests below want. */
const blockWith = (name: string, attackerId: string) => (d: PendingDecision) =>
  d.decisionType === 'declareBlockers'
    ? declareBlocks(d, (_id, subject) => (subject.name === name ? attackerId : null))
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
      const block = blockWith('Test Bruiser', attacker.id)(d);
      if (block !== null) return block;
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
      const block = blockWith('Test Victim', duelist.id)(d);
      if (block !== null) return block;
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

  it('double strike plus trample sends the regular-step remainder to the defending player when the blocker dies in first strike', () => {
    const ctx = combatContext();
    const champion = spawn(
      ctx,
      'P1',
      keywordCreature('Test Champion', 'Double strike, trample', '{1}{W}', '4/4'),
    );
    spawn(ctx, 'P2', keywordCreature('Test Sapling', '', '{1}', '1/1'));

    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Champion', 'P2')(d);
      if (attack !== null) return attack;
      const block = blockWith('Test Sapling', champion.id)(d);
      if (block !== null) return block;
      return pick(d, /Pass|does not/);
    });

    expect(ctx.state.battlefield.find((p) => p.name === 'Test Sapling')).toBeUndefined();
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(33);
  });

  it('trample assigns lethal to the blocker and the rest to the player; deathtouch makes 1 lethal', () => {
    const ctx = combatContext();
    const crusher = spawn(
      ctx,
      'P1',
      keywordCreature('Test Crusher', 'Trample, deathtouch', '{3}{G}', '4/4'),
    );
    spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '3/3'));

    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Crusher', 'P2')(d);
      if (attack !== null) return attack;
      const block = blockWith('Test Wall', crusher.id)(d);
      if (block !== null) return block;
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
        blockDecisions.push((d.presentationBlockDeclaration?.subjects ?? []).map((s) => s.name));
        return declareNoBlocks(d);
      }
      return pick(d, /Pass|does not/);
    });

    // Only the reach creature was offered the block; the grounded 2/2 was never asked
    // (its only possible block is illegal, so it has no choice to make).
    expect(blockDecisions).toHaveLength(1);
    expect(blockDecisions[0]).toEqual(['Test Spider']);
  });

  it('asks for an arbitrary damage division at the combat damage step, not blocker declaration', () => {
    const ctx = combatContext();
    const crusher = spawn(ctx, 'P1', keywordCreature('Test Crusher', '', '{3}{G}', '6/6'));
    const wallA = spawn(ctx, 'P2', keywordCreature('Test Wall A', '', '{2}', '2/2'));
    const wallB = spawn(ctx, 'P2', keywordCreature('Test Wall B', '', '{2}', '2/2'));

    let divisionDecisionStep: string | null = null;
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Crusher', 'P2')(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        return declareBlocks(d, (_id, subject) =>
          subject.name === 'Test Wall A' || subject.name === 'Test Wall B' ? crusher.id : null,
        );
      }
      if (d.decisionType === 'assignCombatDamage') {
        // ADR 0023 item 18: retimed out of `declareBlockers` to fire here instead.
        divisionDecisionStep = ctx.state.step;
        // CR 510.1c: no ordering requirement — split the 6/6's 6 power 3-and-3, well past
        // lethal (2 toughness each) for both, with nothing free to go anywhere else.
        return splitDamage({ [wallA.id]: 3, [wallB.id]: 3 });
      }
      return pick(d, /Pass|does not/);
    });

    expect(divisionDecisionStep).toBe('combatDamage');
    expect(ctx.state.battlefield.some((p) => p.name === 'Test Wall A')).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.name === 'Test Wall B')).toBe(false);
  });

  it('divides damage arbitrarily among 2+ blockers — even lopsided, not lethal-then-cascade (CR 510.1c)', () => {
    const ctx = combatContext();
    const crusher = spawn(ctx, 'P1', keywordCreature('Test Crusher', '', '{3}{G}', '4/4'));
    const wallA = spawn(ctx, 'P2', keywordCreature('Test Wall A', '', '{2}', '3/3'));
    const wallB = spawn(ctx, 'P2', keywordCreature('Test Wall B', '', '{2}', '3/3'));

    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Crusher', 'P2')(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        return declareBlocks(d, (_id, subject) =>
          subject.name === 'Test Wall A' || subject.name === 'Test Wall B' ? crusher.id : null,
        );
      }
      if (d.decisionType === 'assignCombatDamage') {
        // All 4 damage onto Wall A (lethal, at 3 toughness), none onto Wall B — a lethal-first
        // ORDER would have forced at least 1 onto whichever came second; true CR 510.1c division
        // never has to.
        return splitDamage({ [wallA.id]: 4, [wallB.id]: 0 });
      }
      return pick(d, /Pass|does not/);
    });

    expect(ctx.state.battlefield.some((p) => p.cardId === wallA.cardId)).toBe(false);
    const survivor = ctx.state.battlefield.find((p) => p.cardId === wallB.cardId);
    expect(survivor?.damageMarked).toBe(0);
  });

  it('narrates the division actually applied, not the preset option the response named', () => {
    const ctx = combatContext();
    const crusher = spawn(ctx, 'P1', keywordCreature('Test Crusher', '', '{3}{G}', '3/3'));
    const wallA = spawn(ctx, 'P2', keywordCreature('Test Wall A', '', '{2}', '3/3'));
    const wallB = spawn(ctx, 'P2', keywordCreature('Test Wall B', '', '{2}', '1/1'));

    let presetDescription: string | undefined;
    let splitDescription: string | null = null;
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Crusher', 'P2')(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        return declareBlocks(d, (_id, subject) =>
          subject.name === 'Test Wall A' || subject.name === 'Test Wall B' ? crusher.id : null,
        );
      }
      if (d.decisionType === 'assignCombatDamage') {
        // Option 0 reads "All 3 damage to Test Wall A", but the split sends 2 to A and 1 to B —
        // the browser trial's Wall of Omens/Goblin mismatch.
        presetDescription = d.options[0]?.description;
        splitDescription = describeDamageSplit(ctx, 3, { [wallA.id]: 2, [wallB.id]: 1 });
        return splitDamage({ [wallA.id]: 2, [wallB.id]: 1 });
      }
      return pick(d, /Pass|does not/);
    });

    expect(presetDescription).toBe('All 3 damage to Test Wall A');
    expect(splitDescription).toBe('Divide 3 damage: 2 to Test Wall A, 1 to Test Wall B');
    const lines = formatSpectatorLog(ctx.state.eventLog).map((line) => line.text);
    expect(lines).toContain(
      'Test Crusher divides its combat damage: 2 to Test Wall A, 1 to Test Wall B',
    );
    expect(lines.some((line) => line.includes('All 3 damage'))).toBe(false);
  });

  it('an invalid or missing division falls back to dumping everything on the first live blocker', () => {
    const ctx = combatContext();
    const crusher = spawn(ctx, 'P1', keywordCreature('Test Crusher', '', '{3}{G}', '5/5'));
    const wallA = spawn(ctx, 'P2', keywordCreature('Test Wall A', '', '{2}', '2/2'));
    const wallB = spawn(ctx, 'P2', keywordCreature('Test Wall B', '', '{2}', '2/2'));

    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Crusher', 'P2')(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        return declareBlocks(d, (_id, subject) =>
          subject.name === 'Test Wall A' || subject.name === 'Test Wall B' ? crusher.id : null,
        );
      }
      if (d.decisionType === 'assignCombatDamage') {
        return { index: 0, targets: new Map() }; // no combatDamageSplit at all
      }
      return pick(d, /Pass|does not/);
    });

    // All 5 dumped on whichever blocker is first in `blockedByOrdered` — deterministic, never a
    // guess split across both.
    const aAlive = ctx.state.battlefield.some((p) => p.cardId === wallA.cardId);
    const bAlive = ctx.state.battlefield.some((p) => p.cardId === wallB.cardId);
    expect(aAlive).not.toBe(bAlive); // exactly one died, not both, not neither
  });

  it('requires a goaded creature to attack a non-goader when possible', () => {
    const ctx = combatContext();
    // The goaded creature's controller must be the active player — a creature can't be asked
    // to declare attacks during another player's turn. This test previously left `combatContext`'s
    // default P1-active setup in place while spawning under P2, so the callback's `d.player ===
    // 'P2'` branch never matched and the test silently exercised nothing.
    ctx.state.activePlayerIndex = 1;
    ctx.state.currentTurnPlayer = 'P2';
    const attacker = spawn(ctx, 'P2', bear());
    attacker.goadedBy = [{ goaderId: 'P1', appliedTurn: ctx.state.turnNumber - 1 }];

    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers' && d.player === 'P2') {
        expect(subjectMustAttack(d, 'Test Bear')).toBe(true);
        expect(subjectDefenders(d, 'Test Bear')).not.toContain('P1');
        return declareAttacks(d, () => 'P3');
      }
      return pick(d, /Pass|does not/);
    });

    const attack = attackEvents(ctx).find((e) => e.payload['attacker'] === 'Test Bear');
    expect(attack?.payload['defender']).toBe('P3');
  });

  it('allows a goaded creature to attack its goader only when no other defender is available', () => {
    const ctx = combatContext();
    ctx.state.turnOrder = ['P1', 'P2'];
    ctx.state.activePlayerIndex = 1;
    ctx.state.currentTurnPlayer = 'P2';
    const attacker = spawn(ctx, 'P2', bear());
    attacker.goadedBy = [{ goaderId: 'P1', appliedTurn: ctx.state.turnNumber - 1 }];

    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers' && d.player === 'P2') {
        expect(subjectMustAttack(d, 'Test Bear')).toBe(true);
        expect(subjectDefenders(d, 'Test Bear')).toContain('P1');
        return declareAttacks(d, () => 'P1');
      }
      return pick(d, /Pass|does not/);
    });

    const attack = attackEvents(ctx).find((e) => e.payload['attacker'] === 'Test Bear');
    expect(attack?.payload['defender']).toBe('P1');
  });

  it('does not force a goaded creature to pay an attack tax (CR 508.1d)', () => {
    const ctx = combatContext();
    ctx.state.turnOrder = ['P1', 'P2'];
    ctx.state.activePlayerIndex = 1;
    ctx.state.currentTurnPlayer = 'P2';
    // The only opponent (P1, also the goader) has a Ghostly-Prison-style tax up. CR 508.1d: a
    // player is never required to pay a cost merely to satisfy an "attacks if able" requirement,
    // even if paying it and attacking would satisfy the requirement — so this must NOT force
    // the attack, even though P2 can afford the tax (two untapped Forests, below).
    registerCustomDef(ctx, attackTaxDef('test-ghostly-prison', 2));
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Ghostly Prison',
        oracleId: 'test-ghostly-prison',
        typeLine: 'Enchantment',
        manaCost: null,
      }),
    );
    spawn(ctx, 'P2', forest());
    spawn(ctx, 'P2', forest());
    const attacker = spawn(ctx, 'P2', bear());
    attacker.goadedBy = [{ goaderId: 'P1', appliedTurn: ctx.state.turnNumber - 1 }];

    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers' && d.player === 'P2') {
        // Not forced: declining is still a legal choice for this subject...
        expect(subjectMustAttack(d, 'Test Bear')).toBe(false);
        // ...even though attacking P1 (and paying the tax) is still a legal, affordable choice.
        expect(subjectDefenders(d, 'Test Bear')).toContain('P1');
        return declareNoAttacks(d);
      }
      return pick(d, /Pass|does not/);
    });

    expect(attackEvents(ctx).find((e) => e.payload['attacker'] === 'Test Bear')).toBeUndefined();
  });

  it('does force a goaded creature to attack when a free (untaxed) defender is available', () => {
    const ctx = combatContext();
    ctx.state.activePlayerIndex = 1;
    ctx.state.currentTurnPlayer = 'P2';
    // P1 (the goader) has the tax; P3/P4 don't. Free non-goader defenders still exist, so the
    // requirement remains mandatory — the tax only excuses the creature from being forced
    // through a COSTED path, not from the requirement altogether.
    registerCustomDef(ctx, attackTaxDef('test-ghostly-prison-2', 2));
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Ghostly Prison',
        oracleId: 'test-ghostly-prison-2',
        typeLine: 'Enchantment',
        manaCost: null,
      }),
    );
    const attacker = spawn(ctx, 'P2', bear());
    attacker.goadedBy = [{ goaderId: 'P1', appliedTurn: ctx.state.turnNumber - 1 }];

    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers' && d.player === 'P2') {
        expect(subjectMustAttack(d, 'Test Bear')).toBe(true);
        return declareAttacks(d, () => 'P3');
      }
      return pick(d, /Pass|does not/);
    });

    const attack = attackEvents(ctx).find((e) => e.payload['attacker'] === 'Test Bear');
    expect(attack?.payload['defender']).toBe('P3');
  });

  it('keeps multiple goad requirements independent and expires only the active goader requirement', () => {
    const ctx = combatContext();
    // Same active-player requirement as the previous two tests — P3 must be the one attacking.
    ctx.state.activePlayerIndex = 2;
    ctx.state.currentTurnPlayer = 'P3';
    const attacker = spawn(ctx, 'P3', bear());
    attacker.goadedBy = [
      { goaderId: 'P1', appliedTurn: ctx.state.turnNumber - 1 },
      { goaderId: 'P2', appliedTurn: ctx.state.turnNumber - 1 },
    ];

    // Goaded by both P1 and P2, P4 is the only legal non-goader defender left — so this is a
    // *forced* decision (exactly one legal option) and the engine auto-resolves it without ever
    // surfacing it to this callback (brief §5.1). The callback's own assertions would catch P1/P2
    // being offered if they ever were, but the real check is the outcome below: the attack event
    // confirms the auto-resolved choice was P4, not silently nothing.
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers' && d.player === 'P3') {
        expect(subjectDefenders(d, 'Test Bear')).not.toContain('P1');
        expect(subjectDefenders(d, 'Test Bear')).not.toContain('P2');
        return declareAttacks(d, () => 'P4');
      }
      return pick(d, /Pass|does not/);
    });
    const forcedAttack = attackEvents(ctx).find((e) => e.payload['attacker'] === 'Test Bear');
    expect(forcedAttack?.payload['defender']).toBe('P4');

    const nextTurnContext = combatContext();
    const nextTurnPermanent = spawn(nextTurnContext, 'P3', bear());
    nextTurnContext.state.currentTurnPlayer = 'P1';
    nextTurnContext.state.turnNumber = 5;
    nextTurnPermanent.goadedBy = [
      { goaderId: 'P1', appliedTurn: 4 },
      { goaderId: 'P2', appliedTurn: 4 },
    ];
    runTurn(nextTurnContext).next();
    expect(nextTurnPermanent.goadedBy).toEqual([{ goaderId: 'P2', appliedTurn: 4 }]);
  });

  it('surfaces every eligible attacker in one decision (ADR 0023 items 13/14)', () => {
    const ctx = combatContext();
    for (const name of ['Test Alpha', 'Test Beta', 'Test Gamma']) {
      spawn(ctx, 'P1', keywordCreature(name, '', '{1}{G}', '2/2'));
    }

    const attackDecisions: PendingDecision[] = [];
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        attackDecisions.push(d);
        return declareAttacks(d, () => 'P2');
      }
      return pick(d, /Pass|does not/);
    });

    // Three eligible attackers, one decision — not one per creature.
    expect(attackDecisions).toHaveLength(1);
    expect(
      attackDecisions[0]?.presentationAttackDeclaration?.subjects.map((s) => s.name).sort(),
    ).toEqual(['Test Alpha', 'Test Beta', 'Test Gamma']);
    expect(
      attackEvents(ctx)
        .map((e) => e.payload['attacker'])
        .sort(),
    ).toEqual(['Test Alpha', 'Test Beta', 'Test Gamma']);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(34);
  });

  it('a single declaration can send different creatures at different defenders, or decline some', () => {
    const ctx = combatContext();
    for (const name of ['Test Alpha', 'Test Beta', 'Test Gamma']) {
      spawn(ctx, 'P1', keywordCreature(name, '', '{1}{G}', '2/2'));
    }

    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        return declareAttacks(d, (_id, subject) => {
          if (subject.name === 'Test Alpha') return 'P2';
          if (subject.name === 'Test Gamma') return 'P3';
          return null; // Test Beta stays home
        });
      }
      return pick(d, /Pass|does not/);
    });

    expect(attackEvents(ctx).map((e) => [e.payload['attacker'], e.payload['defender']])).toEqual(
      expect.arrayContaining([
        ['Test Alpha', 'P2'],
        ['Test Gamma', 'P3'],
      ]),
    );
    expect(attackEvents(ctx)).toHaveLength(2); // Beta never attacked
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(38);
    expect(ctx.state.players.find((p) => p.id === 'P3')?.life).toBe(38);
  });

  it('leaving every creature unassigned declines the whole attack', () => {
    const ctx = combatContext();
    for (const name of ['Test Alpha', 'Test Beta', 'Test Gamma']) {
      spawn(ctx, 'P1', keywordCreature(name, '', '{1}{G}', '2/2'));
    }

    let attackDecisions = 0;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        attackDecisions++;
        return declareNoAttacks(d);
      }
      return pick(d, /Pass|does not/);
    });

    expect(attackDecisions).toBe(1);
    expect(attackEvents(ctx)).toHaveLength(0);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(40);
  });

  it('surfaces every eligible blocker in one decision and leaving all unassigned declines the whole block (ADR 0023 Phase 4)', () => {
    const ctx = combatContext();
    spawn(ctx, 'P1', keywordCreature('Test Raider', '', '{1}{R}', '3/3'));
    for (const name of ['Test Wall A', 'Test Wall B']) {
      spawn(ctx, 'P2', keywordCreature(name, '', '{2}', '0/4'));
    }

    let blockDecisions = 0;
    const blockSubjectNames: string[] = [];
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Raider', 'P2')(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        blockDecisions++;
        blockSubjectNames.push(
          ...(d.presentationBlockDeclaration?.subjects.map((s) => s.name) ?? []),
        );
        return declareNoBlocks(d);
      }
      return pick(d, /Pass|does not/);
    });

    // Two eligible blockers, one decision — not one per creature.
    expect(blockDecisions).toBe(1);
    expect(blockSubjectNames.sort()).toEqual(['Test Wall A', 'Test Wall B']);
    expect(ctx.state.battlefield.filter((p) => p.blocking !== null)).toHaveLength(0);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(37);
  });

  it('a single block declaration can gang-block one attacker with several creatures', () => {
    const ctx = combatContext();
    spawn(ctx, 'P1', keywordCreature('Test Raider', '', '{1}{R}', '5/5'));
    const wallA = spawn(ctx, 'P2', keywordCreature('Test Wall A', '', '{2}', '2/2'));
    const wallB = spawn(ctx, 'P2', keywordCreature('Test Wall B', '', '{2}', '2/2'));

    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Raider', 'P2')(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        return declareBlocks(d, (_id, subject) =>
          subject.name.startsWith('Test Wall') ? subject.attackers[0]!.attackerId : null,
        );
      }
      if (d.decisionType === 'assignCombatDamage') {
        // No trample: every point of the 5/5's power has to land on one of its two blockers.
        return splitDamage({ [wallA.id]: 2, [wallB.id]: 3 });
      }
      return pick(d, /Pass|does not/);
    });

    // Both walls blocked the same attacker, and both died to the gang-block's damage.
    expect(ctx.state.battlefield.some((p) => p.cardId === wallA.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.cardId === wallB.cardId)).toBe(false);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(40); // fully blocked, no trample
  });

  it('rejects a menace attacker left with only one blocker, then repairs it away on a second failure', () => {
    const ctx = combatContext();
    const menaceAttacker = spawn(
      ctx,
      'P1',
      keywordCreature('Test Menacer', 'Menace', '{1}{R}', '3/3'),
    );
    spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '2/2'));

    let sawRejection = false;
    let repairedEvent = false;
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Menacer', 'P2')(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        const rejection = d.presentationBlockDeclaration?.rejection;
        if (rejection !== undefined) {
          sawRejection = true;
          expect(rejection.violations[0]?.kind).toBe('menace');
        }
        // Always propose the single illegal block — the engine must reject once, then repair
        // it away itself (ADR 0023 item 17) rather than loop forever.
        return declareBlocks(d, (_id, subject) =>
          subject.name === 'Test Wall' ? menaceAttacker.id : null,
        );
      }
      return pick(d, /Pass|does not/);
    });
    repairedEvent = ctx.state.eventLog.some((e) => e.type === 'blockDeclarationRepaired');

    expect(sawRejection).toBe(true);
    expect(repairedEvent).toBe(true);
    // The repair stands the lone blocker down rather than leave an illegal single block in place.
    expect(ctx.state.battlefield.filter((p) => p.blocking !== null)).toHaveLength(0);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(37); // menace attacker got through
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

describe('combat-damage division in the replay log (browser trial, Turn 49/55)', () => {
  it("records the submitted split as the decision's description, not option 0's preset", () => {
    const seats = [0, 1, 2, 3].map(() => ({
      cards: [
        ...copies(12, forest),
        ...copies(12, () => keywordCreature('Test Bear', '', '{G}', '2/2')),
      ],
    }));
    const engine = makeEngine(seats, { seed: 'split-1', turnCap: 30 });
    const providers = new Map<string, RandomDecisionProvider>();
    let divisions = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind !== 'decision') continue;
      const request = step.request;
      if (request.combatDamageSplit !== undefined) {
        // Everything onto the LAST target: option 0 always names the first one, so a log that
        // echoed the option text would say the opposite of what was submitted.
        const { amount, targets } = request.combatDamageSplit;
        const last = targets[targets.length - 1] as string;
        divisions += 1;
        engine.submit({
          requestId: request.requestId,
          actionId: 0,
          combatDamageSplit: Object.fromEntries(
            targets.map((id) => [id, id === last ? amount : 0]),
          ),
        });
        continue;
      }
      let provider = providers.get(request.decidingPlayer);
      if (provider === undefined) {
        provider = new RandomDecisionProvider(`split-1-${request.decidingPlayer}`);
        providers.set(request.decidingPlayer, provider);
      }
      engine.submit(provider.decide(request));
    }

    expect(divisions).toBeGreaterThan(0);
    const log = engine.getState().eventLog;
    const decisions = log.filter(
      (event) =>
        event.type === 'decision' && event.payload['decisionType'] === 'assignCombatDamage',
    );
    expect(decisions).toHaveLength(divisions);
    for (const decision of decisions) {
      const description = String(decision.payload['description']);
      expect(description).toMatch(/^Divide \d+ damage: \d+ to /);
      expect(description).not.toMatch(/^All /);
    }
  });
});
