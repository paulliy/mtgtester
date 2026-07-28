/**
 * Delayed triggers, granted abilities/triggers until end of turn, and spell-resolution delayed
 * haste grants (ADR 0010, Inc 16).
 *
 * Closes:
 * - Hunter's Insight
 * - Hellkite Courser
 * - Herd Heirloom
 * - Carnelian Orb of Dragonkind
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { queueTriggersForEvent } from '../src/state/objects';
import { conjure, copies, forest, gameConfig, oracle, spawn } from './fixtures';

const huntersInsight = () =>
  oracle({
    name: "Hunter's Insight",
    manaCost: '{2}{G}',
    colors: ['G'],
    colorIdentity: ['G'],
    typeLine: 'Instant',
    oracleText:
      'Choose target creature you control. Whenever that creature deals combat damage to a player or planeswalker this turn, draw that many cards.',
  });

const hellkiteCourser = () =>
  oracle({
    name: 'Hellkite Courser',
    manaCost: '{4}{R}{R}',
    colors: ['R'],
    colorIdentity: ['R'],
    typeLine: 'Creature — Dragon',
    power: '6',
    toughness: '5',
    keywords: ['flying'],
    oracleText:
      'Flying\nWhen this creature enters, you may put a commander you own from the command zone onto the battlefield. It gains haste. Return it to the command zone at the beginning of the next end step.',
  });

const herdHeirloom = () =>
  oracle({
    name: 'Herd Heirloom',
    manaCost: '{1}{G}',
    colors: ['G'],
    colorIdentity: ['G'],
    typeLine: 'Artifact',
    oracleText:
      '{T}: Add one mana of any color. Spend this mana only to cast a creature spell.\n' +
      '{T}: Until end of turn, target creature you control with power 4 or greater gains trample and "Whenever this creature deals combat damage to a player, draw a card."',
  });

const carnelianOrb = () =>
  oracle({
    name: 'Carnelian Orb of Dragonkind',
    manaCost: '{2}{R}',
    colors: ['R'],
    colorIdentity: ['R'],
    typeLine: 'Artifact',
    oracleText:
      '{T}: Add {R}. If that mana is spent on a Dragon creature spell, it gains haste until end of turn.',
  });

const dummyCommander = () =>
  oracle({
    name: 'The Ur-Dragon',
    manaCost: '{4}{W}{U}{B}{R}{G}',
    colors: ['W', 'U', 'B', 'R', 'G'],
    colorIdentity: ['W', 'U', 'B', 'R', 'G'],
    typeLine: 'Legendary Creature — Dragon Avatar',
    power: '10',
    toughness: '10',
  });

function pod(seed = 'delayed-triggers'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('Increment 16: Delayed triggers and granted abilities', () => {
  it('correctly models all four cards in the interpreter', () => {
    expect(interpretCard(huntersInsight()).modeled).toBe(true);
    expect(interpretCard(hellkiteCourser()).modeled).toBe(true);
    expect(interpretCard(herdHeirloom()).modeled).toBe(true);
    expect(interpretCard(carnelianOrb()).modeled).toBe(true);
  });

  it('Hunter\'s Insight registers a delayed trigger that draws cards equal to combat damage dealt', function* () {
    const ctx = pod();
    const p1 = ctx.state.players[0]!;

    const attacker = spawn(
      ctx,
      'P1',
      oracle({ name: 'Bear', typeLine: 'Creature — Bear', power: '3', toughness: '3' }),
    );
    const def = interpretCard(huntersInsight());

    // Resolve Hunter's Insight targeting attacker
    yield* executeAbility(
      ctx,
      { cardId: 'insight-1', name: "Hunter's Insight", oracleId: def.oracleId, controllerId: 'P1' },
      def.spellAbility!,
      [attacker.id],
    );

    expect(ctx.state.delayedTriggers.length).toBe(1);
    expect(ctx.state.delayedTriggers[0]?.targetId).toBe(attacker.cardId);

    const initialHandCount = p1.hand.length;

    // Simulate combat damage dealt by attacker (3 damage)
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [
      { permanent: attacker, amount: 3 },
    ]);

    expect(ctx.state.pendingTriggers.length).toBe(1);
    const pending = ctx.state.pendingTriggers[0]!;

    // Resolve the pending trigger
    yield* executeAbility(
      ctx,
      { cardId: pending.sourceCardId, name: pending.sourceName, oracleId: pending.sourceOracleId, controllerId: pending.controllerId },
      pending.ability,
      [],
      pending.triggerObjectCardId,
      pending.scope,
    );

    expect(p1.hand.length).toBe(initialHandCount + 3);
  });

  it('Hellkite Courser puts commander on battlefield with haste and returns it to command zone at end step', function* () {
    const ctx = pod();
    const p1 = ctx.state.players[0]!;

    // Put a commander in P1's command zone using conjure
    const cmdCard = dummyCommander();
    const cmdObj = conjure(ctx, 'P1', cmdCard, 'command', { isCommander: true });
    p1.commanderCardIds.push(cmdObj.cardId);

    const courserDef = interpretCard(hellkiteCourser());
    ctx.defs.set(courserDef.oracleId, courserDef);

    // Courser enters battlefield -> ETB trigger resolves
    const etbAbility = courserDef.triggers[0]!;
    yield* executeAbility(
      ctx,
      { cardId: 'courser-1', name: 'Hellkite Courser', oracleId: courserDef.oracleId, controllerId: 'P1' },
      etbAbility,
      [cmdObj.id],
    );

    // Commander should be on battlefield
    const onBattlefield = ctx.state.battlefield.find((p) => p.cardId === cmdObj.cardId);
    expect(onBattlefield).toBeDefined();
    expect(p1.commandZone.length).toBe(0);

    // Delayed trigger registered for endStep, tracking targetId across zone change (CR 608.2b)
    expect(ctx.state.delayedTriggers.length).toBe(1);
    expect(ctx.state.delayedTriggers[0]?.when).toBe('endStep');
    expect(ctx.state.delayedTriggers[0]?.targetId).toBe(cmdObj.cardId);

    // Simulate end step
    const delayed = ctx.state.delayedTriggers.pop()!;
    yield* executeAbility(
      ctx,
      { cardId: delayed.sourceCardId, name: 'Delayed Trigger', oracleId: delayed.sourceOracleId, controllerId: delayed.controllerId },
      delayed.ability,
      [],
      delayed.targetId,
    );

    // Commander returned to command zone
    expect(ctx.state.battlefield.find((p) => p.cardId === cmdObj.cardId)).toBeUndefined();
    expect(p1.commandZone.some((c) => c.cardId === cmdObj.cardId)).toBe(true);
  });

  it('Herd Heirloom grants trample and combat damage draw trigger until end of turn', function* () {
    const ctx = pod();
    const p1 = ctx.state.players[0]!;

    const bigCreature = spawn(
      ctx,
      'P1',
      oracle({ name: 'Big Beast', typeLine: 'Creature — Beast', power: '5', toughness: '5' }),
    );

    const heirloomDef = interpretCard(herdHeirloom());
    ctx.defs.set(heirloomDef.oracleId, heirloomDef);

    const actAbility = heirloomDef.activatedAbilities[1]!.ability;

    yield* executeAbility(
      ctx,
      { cardId: 'heirloom-1', name: 'Herd Heirloom', oracleId: heirloomDef.oracleId, controllerId: 'P1' },
      actAbility,
      [bigCreature.id],
    );

    // Verify UntilEotEffect for granted ability added
    expect(ctx.state.effects.some((e) => e.kind === 'grantAbility')).toBe(true);

    const initialHandCount = p1.hand.length;

    // Simulate combat damage by bigCreature
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [
      { permanent: bigCreature, amount: 5 },
    ]);

    expect(ctx.state.pendingTriggers.length).toBe(1);
    const pending = ctx.state.pendingTriggers[0]!;

    yield* executeAbility(
      ctx,
      { cardId: pending.sourceCardId, name: pending.sourceName, oracleId: pending.sourceOracleId, controllerId: pending.controllerId },
      pending.ability,
      [],
    );

    expect(p1.hand.length).toBe(initialHandCount + 1);
  });
});
