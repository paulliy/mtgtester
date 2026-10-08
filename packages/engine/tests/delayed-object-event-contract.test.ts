import { describe, expect, it } from 'vitest';
import type { Effect, TriggerWhen } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

describe('delayed object events from ordinary registration spells', () => {
  it.each(['castsSpell', 'gainsLife', 'drawsCard', 'unknown-event'])(
    'rejects unsupported delayed event %s at authoring',
    (when) => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      const card = conjure(
        ctx,
        'P1',
        oracle({
          name: 'Independent delayed authoring probe',
          typeLine: 'Instant',
          manaCost: '{0}',
          oracleText: 'You gain 1 life.',
        }),
        'hand',
      );
      const effect: Effect = {
        op: 'registerDelayedTrigger',
        when: when as TriggerWhen,
        expiry: 'onFire',
        ability: {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
        },
      };
      expect(
        validateCardDefinition({
          ...ctx.defs.get(card.oracleId)!,
          spellAbility: { kind: 'spell', targets: [], effects: [effect] },
        }),
      ).not.toEqual([]);
    },
  );
  it('routes an explicitly captured event player through an object event', () => {
    const state = setup('dies', 'onFire', false, true);
    const before = state.ctx.state.players[1]!.hand.length;
    state.cast({ op: 'destroy', target: 0 });
    expect(state.ctx.state.players[1]!.hand).toHaveLength(before + 1);
    expect(state.player.hand).toHaveLength(0);
  });
  it.each(['dies', 'dealtDamage'] as const)(
    '%s consumes an onFire registration exactly once',
    (when) => {
      const state = setup(when, 'onFire');
      state.cast(
        when === 'dies'
          ? { op: 'destroy', target: 0 }
          : { op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } },
      );
      expect(state.player.life).toBe(43);
      expect(state.ctx.state.delayedTriggers).toHaveLength(0);
      if (when === 'dealtDamage') {
        state.cast({ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } });
        expect(state.player.life).toBe(43);
      }
    },
  );
  it.each(['dies', 'dealtDamage'] as const)(
    '%s does not follow a blinked object or consume its registration',
    (when) => {
      const state = setup(when, 'onFire');
      const original = state.current().id;
      state.cast({ op: 'blinkTarget', target: 0 });
      expect(state.current().id).not.toBe(original);
      state.cast(
        when === 'dies'
          ? { op: 'destroy', target: 0 }
          : { op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } },
      );
      expect(state.player.life).toBe(40);
      expect(state.ctx.state.delayedTriggers).toHaveLength(1);
    },
  );
  it('a nonmatching death does not consume the remembered original', () => {
    const state = setup('dies', 'onFire');
    const other = spawn(state.ctx, 'P2', {
      ...bear(),
      name: 'Independent unrelated victim',
      oracleId: 'unrelated-victim',
    });
    state.cast({ op: 'destroy', target: 0 }, other.id);
    expect(state.player.life).toBe(40);
    expect(state.ctx.state.delayedTriggers).toHaveLength(1);
    state.cast({ op: 'destroy', target: 0 });
    expect(state.player.life).toBe(43);
    expect(state.ctx.state.delayedTriggers).toHaveLength(0);
  });
  it('an end-of-turn registration can fire more than once on the same surviving object', () => {
    const state = setup('dealtDamage', 'cleanup');
    for (let count = 0; count < 2; count++) {
      state.cast({ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } });
    }
    expect(state.player.life).toBe(46);
    expect(state.ctx.state.delayedTriggers).toHaveLength(1);
  });
  it('an event-object effect retains the actual firing incarnation through a later blink', () => {
    const state = setup('dealtDamage', 'onFire', true);
    state.cast({ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } }, undefined, false);
    expect(state.ctx.state.pendingTriggers).toHaveLength(1);
    const original = state.current().id;
    // A normal response spell resolves before the already-fired delayed trigger is placed.
    state.cast({ op: 'blinkTarget', target: 0 }, undefined, false);
    expect(state.current().id).not.toBe(original);
    pump(runPrioritySequence(state.ctx));
    expect(state.current().counters['charge'] ?? 0).toBe(0);
  });
});

function setup(
  when: 'dies' | 'dealtDamage',
  expiry: 'onFire' | 'cleanup',
  acts = false,
  routed = false,
  registeredEffects?: Effect[],
) {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const target = spawn(ctx, 'P2', bear());
  function cast(effect: Effect, targetId?: string, settle = true) {
    const card = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Independent delayed-event spell',
        typeLine: 'Instant',
        manaCost: '{0}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    const definition = {
      ...ctx.defs.get(card.oracleId)!,
      spellAbility: {
        kind: 'spell' as const,
        targets: [{ kind: 'creature' as const }],
        effects: [effect],
      },
    };
    expect(validateCardDefinition(definition)).toEqual([]);
    ctx.defs.set(card.oracleId, definition);
    pump(
      applyPriorityAction(
        ctx,
        player,
        { kind: 'castSpell', objectId: card.id, fromCommand: false },
        { index: 0, targets: new Map([[0, targetId ?? current().id]]) },
      ),
    );
    pump(resolveTopOfStack(ctx));
    if (settle) pump(runPrioritySequence(ctx));
  }
  function current() {
    return ctx.state.battlefield.find((object) => object.cardId === target.cardId)!;
  }
  cast({
    op: 'registerDelayedTrigger',
    target: 0,
    sameObject: true,
    when,
    expiry,
    ...(routed ? { affectedPlayer: 'targetController' as const } : {}),
    ability: {
      kind: 'triggered',
      targets: [],
      effects:
        registeredEffects ??
        (routed
          ? [{ op: 'draw', count: { kind: 'const', n: 1 }, player: 'eventPlayer' }]
          : acts
            ? [
                {
                  op: 'putCounters',
                  target: 'triggerObject',
                  counter: 'charge',
                  count: { kind: 'const', n: 1 },
                },
              ]
            : [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }]),
    },
  });
  expect(ctx.state.delayedTriggers).toHaveLength(1);
  expect(ctx.state.delayedTriggers[0]!.targetObjectId).toBe(target.id);
  return { ctx, player, current, cast };
}

it('a delayed death trigger retains its first graveyard destination and last-known power', () => {
  const state = setup('dies', 'onFire', false, false, [
    { op: 'gainLife', amount: { kind: 'powerOfTriggerObject' } },
    { op: 'graveyardToBattlefield', target: 'triggerObject' },
  ]);
  const original = state.current();
  state.cast({ op: 'destroy', target: 0 });
  const returned = state.ctx.state.battlefield.find((card) => card.cardId === original.cardId)!;
  expect(returned.id).not.toBe(original.id);
  expect(returned.ownerId).toBe('P2');
  expect(returned.controllerId).toBe('P1');
  expect(state.player.life).toBe(42);
});

it('a delayed death trigger cannot follow its first destination through a later zone change', () => {
  const state = setup('dies', 'onFire', false, false, [
    { op: 'gainLife', amount: { kind: 'powerOfTriggerObject' } },
    { op: 'graveyardToBattlefield', target: 'triggerObject' },
  ]);
  const original = state.current();
  state.cast({ op: 'destroy', target: 0 }, undefined, false);
  expect(
    state.ctx.state.players[1]!.graveyard.some((card) => card.cardId === original.cardId),
  ).toBe(true);
  const response = conjure(
    state.ctx,
    'P1',
    oracle({
      name: 'Independent graveyard response',
      typeLine: 'Instant',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  state.ctx.defs.set(response.oracleId, {
    ...state.ctx.defs.get(response.oracleId)!,
    spellAbility: {
      kind: 'spell',
      targets: [{ kind: 'player' }],
      effects: [{ op: 'exileTargetPlayerGraveyard', target: 0 }],
    },
  });
  pump(
    applyPriorityAction(
      state.ctx,
      state.player,
      { kind: 'castSpell', objectId: response.id, fromCommand: false },
      { index: 0, targets: new Map([[0, 'P2']]) },
    ),
  );
  pump(resolveTopOfStack(state.ctx));
  pump(runPrioritySequence(state.ctx));
  expect(state.ctx.state.battlefield.some((card) => card.cardId === original.cardId)).toBe(false);
  expect(state.ctx.state.exile.some((card) => card.cardId === original.cardId)).toBe(true);
  expect(state.player.life).toBe(42);
});
