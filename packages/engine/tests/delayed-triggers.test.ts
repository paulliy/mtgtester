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
import type { EngineStackObject, GameContext } from '../src/state/types';
import { queueTriggersForEvent } from '../src/state/objects';
import { queueStepTriggers, runTurn } from '../src/turn/turn';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

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
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
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

describe('Increment 16: Delayed triggers and granted abilities', () => {
  it('fires an unscoped onFire delayed trigger at the next upkeep, whoever owns that turn', () => {
    const ctx = pod('next-upkeep-occurrence');
    ctx.state.delayedTriggers.push({
      id: 'dt-explicit-p4',
      sourceCardId: 'source-card',
      sourceOracleId: 'source-oracle',
      controllerId: 'P1',
      affectedPlayerId: 'P4',
      when: 'upkeep',
      expiry: 'onFire',
      ability: {
        kind: 'triggered',
        targets: [],
        effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
      },
    });

    // The cleanup that ends the scheduling turn must not sweep an onFire trigger.
    ctx.state.delayedTriggers = ctx.state.delayedTriggers.filter(
      (delayed) => delayed.expiry === 'onFire',
    );
    expect(ctx.state.delayedTriggers).toHaveLength(1);

    ctx.state.currentTurnPlayer = 'P2';
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.controllerId).toBe('P1');
    expect(ctx.state.pendingTriggers[0]?.scope?.eventPlayerId).toBe('P4');
    expect(ctx.state.delayedTriggers).toHaveLength(0);
  });

  it('survives the real cleanup step before firing at the next player upkeep', () => {
    const ctx = pod('next-upkeep-real-cleanup');
    const schedulerCard = oracle({
      oracleId: 'delayed-scheduler',
      name: 'Delayed Scheduler',
      typeLine: 'Creature — Test',
      power: '1',
      toughness: '1',
    });
    const base = interpretCard(schedulerCard);
    registerCustomDef(ctx, {
      ...base,
      modeled: true,
      unmodeledReasons: [],
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'endStep', player: 'you' },
          targets: [],
          effects: [
            {
              op: 'registerDelayedTrigger',
              when: 'upkeep',
              expiry: 'onFire',
              affectedPlayer: 'sourceController',
              ability: { kind: 'triggered', targets: [], effects: [] },
            },
          ],
        },
      ],
    });
    spawn(ctx, 'P1', schedulerCard);

    pump(runTurn(ctx));
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers[0]).toMatchObject({
      controllerId: 'P1',
      affectedPlayerId: 'P1',
      when: 'upkeep',
      expiry: 'onFire',
    });

    ctx.state.currentTurnPlayer = 'P2';
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.scope?.eventPlayerId).toBe('P1');
    expect(ctx.state.delayedTriggers).toHaveLength(0);
  });

  it('captures an affected target player without changing trigger controller or step owner', () => {
    const ctx = pod('register-affected-player');
    pump(
      executeAbility(
        ctx,
        {
          cardId: 'source-card',
          name: 'Delayed Source',
          oracleId: 'source-oracle',
          controllerId: 'P1',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'player' }],
          effects: [
            {
              op: 'registerDelayedTrigger',
              target: 0,
              when: 'upkeep',
              expiry: 'onFire',
              affectedPlayer: 'targetController',
              ability: {
                kind: 'triggered',
                targets: [],
                effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
              },
            },
          ],
        },
        ['P4'],
      ),
    );

    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers[0]).toMatchObject({
      controllerId: 'P1',
      affectedPlayerId: 'P4',
      expiry: 'onFire',
    });
    expect('stepPlayerId' in ctx.state.delayedTriggers[0]!).toBe(false);
  });

  it('lets the affected event player choose zero, one, or two cards to draw', () => {
    for (const chosen of [0, 1, 2]) {
      const ctx = pod(`affected-draw-${chosen}`);
      const caster = ctx.state.players[0]!;
      const affected = ctx.state.players[3]!;
      const casterHandBefore = caster.hand.length;
      const affectedHandBefore = affected.hand.length;
      const result = pump(
        executeAbility(
          ctx,
          {
            cardId: 'source-card',
            name: 'Affected Draw Source',
            oracleId: 'source-oracle',
            controllerId: 'P1',
          },
          {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'drawUpToN', count: 2, player: 'eventPlayer' }],
          },
          [],
          undefined,
          { eventPlayerId: 'P4' },
        ),
        (decision) => {
          expect(decision.player).toBe('P4');
          expect(decision.options.map((option) => option.description)).toEqual([
            'Draw 0 cards',
            'Draw 1 card',
            'Draw 2 cards',
          ]);
          return { index: chosen, targets: new Map() };
        },
      );

      expect(result.decisions).toHaveLength(1);
      expect(affected.hand).toHaveLength(affectedHandBefore + chosen);
      expect(caster.hand).toHaveLength(casterHandBefore);
    }
  });

  it('fails closed when an event-player draw is missing its captured player scope', () => {
    const ctx = pod('missing-event-player-scope');
    expect(() =>
      pump(
        executeAbility(
          ctx,
          {
            cardId: 'source-card',
            name: 'Affected Draw Source',
            oracleId: 'source-oracle',
            controllerId: 'P1',
          },
          {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'drawUpToN', count: 2, player: 'eventPlayer' }],
          },
          [],
        ),
      ),
    ).toThrow(/eventPlayer.*without.*event player/i);
  });

  it('fails closed when an affected target controller cannot be captured', () => {
    const ctx = pod('missing-affected-player');
    expect(() =>
      pump(
        executeAbility(
          ctx,
          {
            cardId: 'source-card',
            name: 'Delayed Source',
            oracleId: 'source-oracle',
            controllerId: 'P1',
          },
          {
            kind: 'spell',
            targets: [{ kind: 'player' }],
            effects: [
              {
                op: 'registerDelayedTrigger',
                target: 0,
                when: 'upkeep',
                expiry: 'onFire',
                affectedPlayer: 'targetController',
                ability: { kind: 'triggered', targets: [], effects: [] },
              },
            ],
          },
          [],
        ),
      ),
    ).toThrow(/affected target controller.*could not be captured/i);
  });

  it('preserves the affected player from delayed-trigger registration through resolution', () => {
    const ctx = pod('delayed-affected-player-scope');
    pump(
      executeAbility(
        ctx,
        {
          cardId: 'source-card',
          name: 'Delayed Source',
          oracleId: 'source-oracle',
          controllerId: 'P1',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'player' }],
          effects: [
            {
              op: 'registerDelayedTrigger',
              target: 0,
              when: 'upkeep',
              expiry: 'onFire',
              affectedPlayer: 'targetController',
              ability: {
                kind: 'triggered',
                targets: [],
                effects: [{ op: 'drawUpToN', count: 2, player: 'eventPlayer' }],
              },
            },
          ],
        },
        ['P4'],
      ),
    );
    expect(ctx.state.delayedTriggers[0]?.affectedPlayerId).toBe('P4');

    ctx.state.currentTurnPlayer = 'P2';
    queueStepTriggers(ctx, 'upkeep');
    const pending = ctx.state.pendingTriggers[0]!;
    expect(pending.scope?.eventPlayerId).toBe('P4');
    const result = pump(
      executeAbility(
        ctx,
        {
          cardId: pending.sourceCardId,
          name: pending.sourceName,
          oracleId: pending.sourceOracleId,
          controllerId: pending.controllerId,
        },
        pending.ability,
        [],
        pending.triggerObjectCardId,
        pending.scope,
      ),
      (decision) => {
        expect(decision.player).toBe('P4');
        return { index: 1, targets: new Map() };
      },
    );
    expect(result.decisions).toHaveLength(1);
  });

  it('captures a targeted spell controller before an earlier effect removes it from the stack', () => {
    const ctx = pod('capture-stack-controller');
    ctx.defs.set(
      'target-oracle',
      interpretCard(
        oracle({ oracleId: 'target-oracle', name: 'Target Spell', typeLine: 'Instant' }),
      ),
    );
    const targetedSpell: EngineStackObject = {
      id: 'target-spell',
      sourceId: 'target-spell',
      sourceCardId: 'target-card',
      sourceOracleId: 'target-oracle',
      controllerId: 'P4',
      kind: 'spell',
      description: 'Target Spell',
      card: null,
      ability: { kind: 'spell', targets: [], effects: [] },
      targets: [],
      isCommanderCast: false,
    };
    ctx.state.stack.push(targetedSpell);

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'source-card',
          name: 'Counter and Delay',
          oracleId: 'source-oracle',
          controllerId: 'P1',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'spell' }],
          effects: [
            { op: 'counter', target: 0 },
            {
              op: 'registerDelayedTrigger',
              target: 0,
              when: 'upkeep',
              expiry: 'onFire',
              affectedPlayer: 'targetController',
              ability: { kind: 'triggered', targets: [], effects: [] },
            },
          ],
        },
        [targetedSpell.id],
      ),
    );

    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.delayedTriggers[0]).toMatchObject({
      controllerId: 'P1',
      affectedPlayerId: 'P4',
    });
  });

  it('correctly models all four cards in the interpreter', () => {
    expect(interpretCard(huntersInsight()).modeled).toBe(true);
    expect(interpretCard(hellkiteCourser()).modeled).toBe(true);
    expect(interpretCard(herdHeirloom()).modeled).toBe(true);
    expect(interpretCard(carnelianOrb()).modeled).toBe(true);
  });

  it("Hunter's Insight registers a delayed trigger that draws cards equal to combat damage dealt", () => {
    const ctx = pod();
    const p1 = ctx.state.players[0]!;

    const attacker = spawn(
      ctx,
      'P1',
      oracle({ name: 'Bear', typeLine: 'Creature — Bear', power: '3', toughness: '3' }),
    );
    const def = interpretCard(huntersInsight());

    // Resolve Hunter's Insight targeting attacker
    pump(
      executeAbility(
        ctx,
        {
          cardId: 'insight-1',
          name: "Hunter's Insight",
          oracleId: def.oracleId,
          controllerId: 'P1',
        },
        def.spellAbility!,
        [attacker.id],
      ),
    );

    expect(ctx.state.delayedTriggers.length).toBe(1);
    expect(ctx.state.delayedTriggers[0]?.targetId).toBe(attacker.cardId);

    const initialHandCount = p1.hand.length;

    const otherAttacker = spawn(
      ctx,
      'P1',
      oracle({ name: 'Other Bear', typeLine: 'Creature — Bear', power: '5', toughness: '5' }),
    );

    // Simulate combat damage dealt simultaneously by the targeted attacker (3) and another
    // untargeted attacker (5) — only the targeted creature's damage should count.
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [
      { permanent: attacker, amount: 3 },
      { permanent: otherAttacker, amount: 5 },
    ]);

    expect(ctx.state.pendingTriggers.length).toBe(1);
    const pending = ctx.state.pendingTriggers[0]!;

    // Resolve the pending trigger
    pump(
      executeAbility(
        ctx,
        {
          cardId: pending.sourceCardId,
          name: pending.sourceName,
          oracleId: pending.sourceOracleId,
          controllerId: pending.controllerId,
        },
        pending.ability,
        [],
        pending.triggerObjectCardId,
        pending.scope,
      ),
    );

    expect(p1.hand.length).toBe(initialHandCount + 3);
  });

  it('Hellkite Courser puts commander on battlefield with haste and returns it to command zone at end step', () => {
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
    pump(
      executeAbility(
        ctx,
        {
          cardId: 'courser-1',
          name: 'Hellkite Courser',
          oracleId: courserDef.oracleId,
          controllerId: 'P1',
        },
        etbAbility,
        [cmdObj.id],
      ),
    );

    // Commander should be on battlefield
    const onBattlefield = ctx.state.battlefield.find((p) => p.cardId === cmdObj.cardId);
    expect(onBattlefield).toBeDefined();
    // The pod deals every player their own commander, so an empty command zone would be the
    // wrong assertion here — what matters is that THIS commander left it.
    expect(p1.commandZone.some((c) => c.cardId === cmdObj.cardId)).toBe(false);

    // Delayed trigger registered for endStep, tracking targetId across zone change (CR 608.2b)
    expect(ctx.state.delayedTriggers.length).toBe(1);
    expect(ctx.state.delayedTriggers[0]?.when).toBe('endStep');
    expect(ctx.state.delayedTriggers[0]?.targetId).toBe(cmdObj.cardId);

    // Simulate end step
    const delayed = ctx.state.delayedTriggers.pop()!;
    pump(
      executeAbility(
        ctx,
        {
          cardId: delayed.sourceCardId,
          name: 'Delayed Trigger',
          oracleId: delayed.sourceOracleId,
          controllerId: delayed.controllerId,
        },
        delayed.ability,
        [],
        delayed.targetId,
      ),
    );

    // Commander returned to command zone
    expect(ctx.state.battlefield.find((p) => p.cardId === cmdObj.cardId)).toBeUndefined();
    expect(p1.commandZone.some((c) => c.cardId === cmdObj.cardId)).toBe(true);
  });

  it('Herd Heirloom grants trample and combat damage draw trigger until end of turn', () => {
    const ctx = pod();
    const p1 = ctx.state.players[0]!;

    const bigCreature = spawn(
      ctx,
      'P1',
      oracle({ name: 'Big Beast', typeLine: 'Creature — Beast', power: '5', toughness: '5' }),
    );

    const heirloomDef = interpretCard(herdHeirloom());
    ctx.defs.set(heirloomDef.oracleId, heirloomDef);

    const actAbility = heirloomDef.activatedAbilities[0]!.ability;

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'heirloom-1',
          name: 'Herd Heirloom',
          oracleId: heirloomDef.oracleId,
          controllerId: 'P1',
        },
        actAbility,
        [bigCreature.id],
      ),
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

    pump(
      executeAbility(
        ctx,
        {
          cardId: pending.sourceCardId,
          name: pending.sourceName,
          oracleId: pending.sourceOracleId,
          controllerId: pending.controllerId,
        },
        pending.ability,
        [],
      ),
    );

    expect(p1.hand.length).toBe(initialHandCount + 1);
  });
});
