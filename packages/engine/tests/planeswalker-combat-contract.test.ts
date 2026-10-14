import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
import { createGame } from '../src/state/game';
import { changeController, moveObject } from '../src/state/objects';
import { bear, conjure, copies, declareAttacks, declareBlocks, declareNoBlocks, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function setup() {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed: 'walker-combat' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.turnNumber = 4;
  const attacker = spawn(ctx, 'P1', bear());
  const walker = spawn(ctx, 'P2', oracle({ name: 'Combat Test Walker', typeLine: 'Planeswalker', loyalty: '8' }));
  walker.counters['loyalty'] = 8;
  return { ctx, attacker, walker };
}

describe('planeswalker combat defender contract', () => {
  it('offers the actual permanent id while retaining controller life and identity', () => {
    const { ctx, walker } = setup();
    const result = pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        const subject = d.presentationAttackDeclaration!.subjects[0]!;
        expect(subject.defenders.find((defender) => defender.defenderId === walker.id)).toMatchObject({ playerId: 'P2', life: 40, name: walker.name });
        expect(d.options[0]!.targets![0]!.options).toContain(walker.id);
        return declareAttacks(d, () => walker.id);
      }
      return { index: 0, targets: new Map() };
    });
    expect(result.decisions.some((d) => d.decisionType === 'declareAttackers')).toBe(true);
    expect(walker.counters['loyalty']).toBe(6);
    expect(ctx.state.players[1]!.life).toBe(40);
    expect(ctx.state.combat).toBeNull();
  });

  it('lets the defending controller block attacks to both itself and its planeswalker in one declaration', () => {
    const { ctx, attacker, walker } = setup();
    const other = spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    let declarations = 0;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') return declareAttacks(d, (id) => id === attacker.id ? walker.id : 'P2');
      if (d.decisionType === 'declareBlockers') {
        declarations++;
        expect(d.player).toBe('P2');
        expect(d.presentationBlockDeclaration!.subjects[0]!.attackers.map((a) => a.attackerId)).toEqual(expect.arrayContaining([attacker.id, other.id]));
        return declareBlocks(d, () => attacker.id);
      }
      return { index: 0, targets: new Map() };
    });
    expect(declarations).toBe(1);
    expect(walker.counters['loyalty']).toBe(8);
    expect(ctx.state.players[1]!.life).toBe(38);
  });

  it('does not apply a player-only attack tax to a planeswalker', () => {
    const { ctx, walker } = setup();
    spawn(ctx, 'P2', oracle({ name: 'Player Tax', typeLine: 'Enchantment', oracleText: "Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you." }));
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        const options = d.options[0]!.targets![0]!.options;
        expect(options).not.toContain('P2');
        expect(options).toContain(walker.id);
        return declareAttacks(d, () => walker.id);
      }
      return { index: 0, targets: new Map() };
    });
    expect(walker.counters['loyalty']).toBe(6);
  });

  it('goad requires an available free player other than its goader rather than a planeswalker', () => {
    const { ctx, attacker, walker } = setup();
    attacker.goadedBy = [{ goaderId: 'P3', appliedTurn: 3 }];
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        expect(d.options[0]!.targets![0]!.options).not.toContain(walker.id);
        return declareAttacks(d, () => 'P2');
      }
      return { index: 0, targets: new Map() };
    });
    expect(walker.counters['loyalty']).toBe(8);
  });

  it('maximizes multiple independent goad requirements when every opponent is a goader', () => {
    const { ctx, attacker, walker } = setup();
    attacker.goadedBy = ['P2', 'P3', 'P4'].map((goaderId) => ({ goaderId, appliedTurn: 3 }));
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        expect(d.options[0]!.targets![0]!.options).not.toContain(walker.id);
        return declareAttacks(d, () => 'P2');
      }
      return { index: 0, targets: new Map() };
    });
    expect(walker.counters['loyalty']).toBe(8);
  });

  it('assigns trample excess to the planeswalker without damaging its controller', () => {
    const { ctx, attacker, walker } = setup();
    ctx.state.effects.push({ id: 'combat-effect', sourceId: attacker.cardId, description: 'Combat test effect', kind: 'ptDelta', power: 2, toughness: 2, targetCardIds: [attacker.cardId], timestamp: ctx.state.nextTimestamp++ },
      { id: 'combat-effect', sourceId: attacker.cardId, description: 'Combat test effect', kind: 'grantKeyword', keyword: 'trample', targetCardIds: [attacker.cardId], timestamp: ctx.state.nextTimestamp++ });
    const blocker = spawn(ctx, 'P2', bear());
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') return declareAttacks(d, () => walker.id);
      if (d.decisionType === 'declareBlockers') return declareBlocks(d, () => attacker.id);
      if (d.decisionType === 'assignCombatDamage') return { index: 0, targets: new Map(), combatDamageSplit: { [blocker.id]: 2, [walker.id]: 2 } };
      return { index: 0, targets: new Map() };
    });
    expect(walker.counters['loyalty']).toBe(6);
    expect(ctx.state.players[1]!.life).toBe(40);
  });

  for (const departure of ['leave', 'control'] as const) it(`keeps attackers from damaging a planeswalker removed from combat by ${departure}`, () => {
    const { ctx, walker } = setup();
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', oracle({ name: 'Priority Witness', typeLine: 'Instant', manaCost: '{0}', oracleText: 'Draw a card.' }), 'hand');
    let removed = false;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') return declareAttacks(d, () => walker.id);
      if (!removed && ctx.state.step === 'declareAttackers') {
        removed = true;
        if (departure === 'leave') pump(moveObject(ctx, walker, { zone: 'hand' }));
        else { changeController(ctx, walker, 'P3'); changeController(ctx, walker, 'P2'); }
      }
      if (d.decisionType === 'declareBlockers') return declareNoBlocks(d);
      return { index: 0, targets: new Map() };
    });
    expect(removed).toBe(true);
    expect(ctx.state.players[1]!.life).toBe(40);
    expect(walker.counters['loyalty']).toBe(8);
  });
});
