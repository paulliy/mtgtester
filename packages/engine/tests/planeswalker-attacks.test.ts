/**
 * Creatures attacking planeswalkers (CR 506.2, 506.4, 508.1b, 510.1, 702.19): declaration options,
 * attack taxes scoped to the player or its planeswalkers, goad, combat damage to loyalty through
 * the damage pipeline, trample excess, a planeswalker leaving or changing controller mid-combat,
 * and the "attacks you" conditions that must not fire for a planeswalker attack.
 */

import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
import { attackedPlaneswalker } from '../src/state/queries';
import { evaluateCondition } from '../src/cards/condition';
import type { CardDefinition } from '../src/cards/definition';
import type { PendingDecision } from '../src/decisions';
import { changeController, moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { counterCount } from '../src/state/counters';
import { RandomDecisionProvider } from '../src/providers/providers';
import {
  bear,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  keywordCreature,
  makeEngine,
  oracle,
  pick,
  pump,
  registerCustomDef,
  spawn,
  splitDamage,
} from './fixtures';

const walker = (name = 'Test Walker', loyalty = '4') =>
  oracle({
    name,
    typeLine: 'Planeswalker — Test',
    manaCost: '{2}',
    cmc: 2,
    loyalty,
    oracleText: '',
  });

function board(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  return ctx;
}

const loyaltyOf = (perm: EnginePermanent): number => counterCount(perm.counters, 'loyalty');

/** Only `name` attacks, at `target` (a player id or planeswalker object id). */
const attackWith = (name: string, target: string) => (d: PendingDecision) =>
  d.decisionType === 'declareAttackers'
    ? declareAttacks(d, (_id, subject) => (subject.name === name ? target : null))
    : null;

const blockWith = (name: string, attackerId: string) => (d: PendingDecision) =>
  d.decisionType === 'declareBlockers'
    ? declareBlocks(d, (_id, subject) => (subject.name === name ? attackerId : null))
    : null;

function fight(
  ctx: GameContext,
  ...answers: Array<(d: PendingDecision) => ReturnType<typeof pick> | null>
): PendingDecision[] {
  return pump(runCombatPhase(ctx), (d) => {
    for (const answer of answers) {
      const outcome = answer(d);
      if (outcome !== null) return outcome;
    }
    if (d.decisionType === 'declareAttackers') return declareAttacks(d, () => null);
    if (d.decisionType === 'declareBlockers') return declareBlocks(d, () => null);
    return pick(d, /Pass|does not/);
  }).decisions;
}

const attackEvents = (ctx: GameContext) => ctx.state.eventLog.filter((e) => e.type === 'attack');

function taxDef(oracleId: string, includePlaneswalkers: boolean): CardDefinition {
  return {
    oracleId,
    name: oracleId,
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
    ruleStatics: [
      { kind: 'attackTax', amount: 2, ...(includePlaneswalkers ? { includePlaneswalkers } : {}) },
    ],
    modeled: true,
    unmodeledReasons: [],
  };
}

describe('attacking planeswalkers (CR 508.1b)', () => {
  it('offers each opponent planeswalker as an attack option and not your own', () => {
    const ctx = board('pw-options');
    spawn(ctx, 'P1', bear());
    const mine = spawn(ctx, 'P1', walker('Own Walker'));
    const theirs = spawn(ctx, 'P2', walker('Their Walker'));
    let seen: string[] = [];
    fight(ctx, (d) => {
      const subject = d.presentationAttackDeclaration?.subjects[0];
      if (subject === undefined) return null;
      seen = subject.planeswalkers.map((p) => p.objectId);
      expect(subject.planeswalkers).toEqual([
        { objectId: theirs.id, controllerId: 'P2', name: 'Their Walker', loyalty: 4, attackTax: 0 },
      ]);
      // The slot's options are the players, then the planeswalkers, then declining.
      expect(d.options[0]?.targets?.[0]?.options).toEqual([
        'P2',
        'P3',
        'P4',
        theirs.id,
        '__no_attack__',
      ]);
      return declareAttacks(d, () => null);
    });
    expect(seen).toEqual([theirs.id]);
    expect(seen).not.toContain(mine.id);
  });

  it('deals an unblocked attacker’s combat damage to the planeswalker, not the player', () => {
    const ctx = board('pw-unblocked');
    spawn(ctx, 'P1', bear());
    const target = spawn(ctx, 'P2', walker());
    fight(ctx, attackWith('Test Bear', target.id));
    expect(loyaltyOf(target)).toBe(2);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(40);
    expect(attackEvents(ctx)[0]?.payload['planeswalker']).toBe('Test Walker');
    // Combat is over: nothing is left attacking.
    expect(ctx.state.battlefield.every((p) => p.attacking === null)).toBe(true);
    expect(ctx.state.battlefield.every((p) => p.attackingPlaneswalker === null)).toBe(true);
  });

  it('is not combat damage to a player: no commander damage, no player-damage totals', () => {
    const ctx = board('pw-commander');
    spawn(ctx, 'P1', bear(), { isCommander: true });
    const target = spawn(ctx, 'P2', walker());
    fight(ctx, attackWith('Test Bear', target.id));
    const p2 = ctx.state.players.find((p) => p.id === 'P2')!;
    expect(Object.values(p2.commanderDamageTaken)).toEqual([]);
    expect(ctx.state.damageDealtToPlayersThisTurn['P2'] ?? 0).toBe(0);
    expect(ctx.state.combatDamagePlayersBySource).toEqual({});
  });

  it('gains life from lifelink damage dealt to the planeswalker', () => {
    const ctx = board('pw-lifelink');
    spawn(ctx, 'P1', keywordCreature('Test Lifelinker', 'Lifelink', '{1}{W}', '3/3'));
    const target = spawn(ctx, 'P2', walker());
    fight(ctx, attackWith('Test Lifelinker', target.id));
    expect(loyaltyOf(target)).toBe(1);
    expect(ctx.state.players.find((p) => p.id === 'P1')?.life).toBe(43);
  });

  it('removes a planeswalker reduced to zero loyalty (CR 704.5i)', () => {
    const ctx = board('pw-dies');
    spawn(ctx, 'P1', keywordCreature('Test Brute', '', '{3}', '5/5'));
    const target = spawn(ctx, 'P2', walker());
    fight(ctx, attackWith('Test Brute', target.id));
    expect(ctx.state.battlefield.some((p) => p.id === target.id)).toBe(false);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.graveyard.map((c) => c.name)).toContain(
      'Test Walker',
    );
  });

  it('lets the planeswalker’s controller block, and a blocked attacker hurts only the blocker', () => {
    const ctx = board('pw-blocked');
    const attacker = spawn(ctx, 'P1', bear());
    const target = spawn(ctx, 'P2', walker());
    spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '1/4'));
    fight(ctx, attackWith('Test Bear', target.id), blockWith('Test Wall', attacker.id));
    expect(loyaltyOf(target)).toBe(4);
    expect(attacker.damageMarked).toBe(1);
  });

  it('assigns trample excess to the planeswalker it attacks (CR 702.19b)', () => {
    const ctx = board('pw-trample');
    const attacker = spawn(ctx, 'P1', keywordCreature('Test Trampler', 'Trample', '{3}{G}', '5/5'));
    const target = spawn(ctx, 'P2', walker());
    const wall = spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '1/2'));
    let offered: string[] = [];
    fight(ctx, attackWith('Test Trampler', target.id), blockWith('Test Wall', attacker.id), (d) => {
      if (d.decisionType !== 'assignCombatDamage') return null;
      offered = d.combatDamageSplit?.targets ?? [];
      return splitDamage({ [wall.id]: 2, [target.id]: 3 });
    });
    // The single blocker's lethal plus the planeswalker as the excess recipient.
    expect(offered).toEqual([wall.id, target.id]);
    // 2 lethal to the wall, 3 left over for the planeswalker, none for the player.
    expect(loyaltyOf(target)).toBe(1);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(40);
  });

  it('offers the planeswalker as a recipient when dividing a trampler’s damage among blockers', () => {
    const ctx = board('pw-trample-split');
    const attacker = spawn(ctx, 'P1', keywordCreature('Test Trampler', 'Trample', '{3}{G}', '6/6'));
    const target = spawn(ctx, 'P2', walker());
    const w1 = spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '1/1'));
    const w2 = spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '1/1'));
    let split: string[] = [];
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Trampler', target.id)(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        return declareBlocks(d, () => attacker.id);
      }
      if (d.decisionType === 'assignCombatDamage') {
        split = d.combatDamageSplit?.targets ?? [];
        return splitDamage({ [w1.id]: 1, [w2.id]: 1, [target.id]: 4 });
      }
      return pick(d, /Pass|does not/);
    });
    expect(split).toEqual([w1.id, w2.id, target.id]);
    expect(loyaltyOf(target)).toBe(0);
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(40);
  });

  it('keeps nothing for a planeswalker until every blocker has lethal (CR 702.19b)', () => {
    const ctx = board('pw-trample-lethal');
    const attacker = spawn(ctx, 'P1', keywordCreature('Test Trampler', 'Trample', '{3}{G}', '4/4'));
    const target = spawn(ctx, 'P2', walker());
    const w1 = spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '2/2'));
    const w2 = spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '2/2'));
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Trampler', target.id)(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') return declareBlocks(d, () => attacker.id);
      if (d.decisionType === 'assignCombatDamage') {
        // 3 to the walker with a blocker short of lethal is illegal: the division is replaced.
        return splitDamage({ [w1.id]: 1, [w2.id]: 0, [target.id]: 3 });
      }
      return pick(d, /Pass|does not/);
    });
    expect(loyaltyOf(target)).toBe(4);
  });
});

describe('a planeswalker removed from combat (CR 506.4, 506.4c, 510.1b)', () => {
  it('leaves an unblocked attacker attacking nothing, and it deals no damage', () => {
    const ctx = board('pw-leaves');
    const attacker = spawn(ctx, 'P1', bear());
    const target = spawn(ctx, 'P2', walker());
    spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '1/4'));
    let stillAttacking = false;
    let attacksWalker = true;
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Bear', target.id)(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        // The planeswalker is destroyed after attackers are declared.
        pump(moveObject(ctx, target, { zone: 'graveyard' }));
        attacksWalker = attackedPlaneswalker(ctx, attacker) !== null;
        stillAttacking = attacker.attacking === 'P2' && attacker.statuses.includes('attacking');
        return declareBlocks(d, () => null);
      }
      return pick(d, /Pass|does not/);
    });
    // Still an attacking creature (CR 506.4c), but attacking nothing: no damage to anyone.
    expect(stillAttacking).toBe(true);
    expect(attacksWalker).toBe(false);
    expect(ctx.state.players.every((p) => p.life === 40)).toBe(true);
    expect(ctx.state.battlefield.find((p) => p.name === 'Test Wall')?.damageMarked).toBe(0);
  });

  it('still lets the defending player block it', () => {
    const ctx = board('pw-leaves-block');
    const attacker = spawn(ctx, 'P1', bear());
    const target = spawn(ctx, 'P2', walker());
    spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '1/4'));
    let blockerSawAttacker = false;
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Bear', target.id)(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        // The planeswalker left in the declare attackers step; the Bear is still an attacker
        // of P2 and P2's Wall may block it.
        return declareBlocks(d, (_id, subject) => {
          blockerSawAttacker = subject.attackers.some((a) => a.attackerId === attacker.id);
          return attacker.id;
        });
      }
      if (ctx.state.step === 'declareAttackers' && ctx.state.battlefield.includes(target)) {
        pump(moveObject(ctx, target, { zone: 'graveyard' }));
      }
      return pick(d, /Pass|does not/);
    });
    expect(blockerSawAttacker).toBe(true);
    // The block happened: the Wall dealt its damage to the Bear.
    expect(attacker.damageMarked).toBe(1);
  });

  it('removes the attacker’s trample excess too: nothing goes to the player', () => {
    const ctx = board('pw-leaves-trample');
    const attacker = spawn(ctx, 'P1', keywordCreature('Test Trampler', 'Trample', '{3}{G}', '5/5'));
    const target = spawn(ctx, 'P2', walker());
    const wall = spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '1/2'));
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Trampler', target.id)(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        pump(moveObject(ctx, target, { zone: 'graveyard' }));
        return declareBlocks(d, () => attacker.id);
      }
      return pick(d, /Pass|does not/);
    });
    // With no player or planeswalker to assign excess to, all 5 goes to the wall; the player is
    // untouched (CR 702.19c).
    expect(wall.damageMarked).toBe(5);
    expect(ctx.state.players.every((p) => p.life === 40)).toBe(true);
  });

  it('removes an attacked planeswalker that changes controller, for good', () => {
    const ctx = board('pw-control');
    spawn(ctx, 'P1', bear());
    const target = spawn(ctx, 'P2', walker());
    spawn(ctx, 'P2', keywordCreature('Test Wall', '', '{2}', '1/4'));
    pump(runCombatPhase(ctx), (d) => {
      const attack = attackWith('Test Bear', target.id)(d);
      if (attack !== null) return attack;
      if (d.decisionType === 'declareBlockers') {
        changeController(ctx, target, 'P3');
        // Getting it back does not put it back into combat.
        changeController(ctx, target, 'P2');
        return declareBlocks(d, () => null);
      }
      return pick(d, /Pass|does not/);
    });
    expect(loyaltyOf(target)).toBe(4);
    expect(ctx.state.players.every((p) => p.life === 40)).toBe(true);
  });
});

describe('attack taxes and goad scoped by target', () => {
  it('Ghostly Prison and Propaganda tax only attacks on the player; Norn’s Annex also its planeswalkers', () => {
    const ctx = board('pw-tax');
    registerCustomDef(ctx, taxDef('test-prison', false));
    registerCustomDef(ctx, taxDef('test-annex', true));
    spawn(
      ctx,
      'P2',
      oracle({ name: 'Prison', oracleId: 'test-prison', typeLine: 'Enchantment', manaCost: null }),
    );
    spawn(
      ctx,
      'P3',
      oracle({ name: 'Annex', oracleId: 'test-annex', typeLine: 'Enchantment', manaCost: null }),
    );
    const w2 = spawn(ctx, 'P2', walker('P2 Walker'));
    const w3 = spawn(ctx, 'P3', walker('P3 Walker'));
    spawn(ctx, 'P1', bear());
    // P1 has no mana: only untaxed targets are offered.
    let options: string[] = [];
    fight(ctx, (d) => {
      if (d.decisionType !== 'declareAttackers') return null;
      options = d.options[0]?.targets?.[0]?.options ?? [];
      return declareAttacks(d, () => null);
    });
    expect(options).not.toContain('P2'); // Prison taxes attacks on P2
    expect(options).toContain(w2.id); // ...but not on P2's planeswalker
    expect(options).not.toContain('P3');
    expect(options).not.toContain(w3.id); // Annex taxes P3's planeswalkers too
    expect(options).toContain('P4');
  });

  it('keeps a goaded creature off a planeswalker while a non-goader player can be attacked', () => {
    const ctx = board('pw-goad');
    const attacker = spawn(ctx, 'P1', bear());
    attacker.goadedBy = [{ goaderId: 'P2', appliedTurn: ctx.state.turnNumber - 1 }];
    const goaderWalker = spawn(ctx, 'P2', walker('P2 Walker'));
    const otherWalker = spawn(ctx, 'P3', walker('P3 Walker'));
    let options: string[] = [];
    fight(ctx, (d) => {
      if (d.decisionType !== 'declareAttackers') return null;
      options = d.options[0]?.targets?.[0]?.options ?? [];
      return declareAttacks(d, () => 'P3');
    });
    // Goad requires attacking a player other than the goader; planeswalkers don't satisfy it.
    expect(options).toEqual(['P3', 'P4']);
    expect(options).not.toContain(goaderWalker.id);
    expect(options).not.toContain(otherWalker.id);
  });

  it('lets a goaded creature attack any player or planeswalker when no non-goader player is attackable', () => {
    const ctx = board('pw-goad-only');
    for (const id of ['P3', 'P4']) {
      const player = ctx.state.players.find((p) => p.id === id)!;
      player.hasLost = true;
    }
    ctx.state.turnOrder = ['P1', 'P2'];
    const attacker = spawn(ctx, 'P1', bear());
    attacker.goadedBy = [{ goaderId: 'P2', appliedTurn: ctx.state.turnNumber - 1 }];
    const goaderWalker = spawn(ctx, 'P2', walker('P2 Walker'));
    let options: string[] = [];
    fight(ctx, (d) => {
      if (d.decisionType !== 'declareAttackers') return null;
      options = d.options[0]?.targets?.[0]?.options ?? [];
      return declareAttacks(d, () => goaderWalker.id);
    });
    expect(options).toEqual(['P2', goaderWalker.id]);
    expect(loyaltyOf(goaderWalker)).toBe(2);
  });
});

describe('"attacks you" is about the player, not their planeswalker', () => {
  function attackerAt(target: 'player' | 'walker') {
    const ctx = board(`pw-cond-${target}`);
    const attacker = spawn(ctx, 'P1', bear());
    const wp = spawn(ctx, 'P2', walker());
    ctx.state.players.find((p) => p.id === 'P2')!.life = 50;
    attacker.attacking = 'P2';
    attacker.attackingPlaneswalker = target === 'walker' ? wp.id : null;
    return { ctx, attacker };
  }
  const scope = (attacker: EnginePermanent) => ({
    sourceCardId: attacker.cardId,
    sourceObjectId: attacker.id,
    controllerId: 'P1',
  });

  it('dethrone (attacking the player with the most life) is false for a planeswalker attack', () => {
    const player = attackerAt('player');
    expect(
      evaluateCondition(
        player.ctx,
        { kind: 'attackingPlayerHasMoreLife' },
        scope(player.attacker) as never,
      ),
    ).toBe(true);
    const pw = attackerAt('walker');
    expect(
      evaluateCondition(
        pw.ctx,
        { kind: 'attackingPlayerHasMoreLife' },
        scope(pw.attacker) as never,
      ),
    ).toBe(false);
  });

  it('"attacking an opponent" is false for a planeswalker attack', () => {
    for (const [target, expected] of [
      ['player', true],
      ['walker', false],
    ] as const) {
      const { ctx, attacker } = attackerAt(target);
      expect(
        evaluateCondition(ctx, { kind: 'triggerObjectAttackingOpponent' }, {
          ...scope(attacker),
          triggerObjectCardId: attacker.cardId,
          triggerObjectId: attacker.id,
        } as never),
      ).toBe(expected);
    }
  });
});

describe('games with planeswalkers on board', () => {
  it('a full random game with planeswalkers in every deck runs to completion and sees planeswalker attacks', () => {
    let planeswalkerAttacks = 0;
    for (const seed of ['pw-game-1', 'pw-game-2', 'pw-game-3']) {
      const seats = [0, 1, 2, 3].map(() => ({
        cards: [
          ...copies(8, forest),
          ...copies(4, () => walker('Deck Walker', '5')),
          ...copies(12, () => keywordCreature('Test Bear', '', '{G}', '2/2')),
        ],
      }));
      const engine = makeEngine(seats, { seed, turnCap: 12 });
      const providers = new Map<string, RandomDecisionProvider>();
      for (let i = 0; i < 40_000; i += 1) {
        const step = engine.advance();
        if (step.kind === 'gameOver') break;
        if (step.kind !== 'decision') continue;
        const request = step.request;
        let provider = providers.get(request.decidingPlayer);
        if (provider === undefined) {
          provider = new RandomDecisionProvider(`${seed}-${request.decidingPlayer}`);
          providers.set(request.decidingPlayer, provider);
        }
        engine.submit(provider.decide(request));
      }
      planeswalkerAttacks += engine
        .getState()
        .eventLog.filter(
          (e) => e.type === 'attack' && e.payload['planeswalker'] !== undefined,
        ).length;
    }
    expect(planeswalkerAttacks).toBeGreaterThan(0);
  }, 120_000);
});
