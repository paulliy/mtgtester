import { describe, expect, it } from 'vitest';
import type { TargetSpec } from '../src/cards/ability';
import { graveyardCardTarget, counterSpellTarget, targetSlots } from '../src/cards/templates';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

function setup(typeLine = 'Sorcery') {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const card = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Independent target builder probe',
      typeLine,
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  const install = (target: TargetSpec) => {
    const targets = targetSlots({ card: target });
    const definition = {
      ...ctx.defs.get(card.oracleId)!,
      spellAbility: {
        kind: 'spell' as const,
        targets: targets.targets,
        effects: [{ op: 'graveyardToHand' as const, target: targets.slot.card }],
      },
    };
    expect(validateCardDefinition(definition)).toEqual([]);
    ctx.defs.set(card.oracleId, definition);
  };
  const offered = () =>
    computePriorityOptions(ctx, player).find(
      (option) => (option.payload as { objectId?: string }).objectId === card.id,
    );
  const cast = (id: string) => {
    const option = offered();
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, id]]),
      }),
    );
    pump(resolveTopOfStack(ctx));
  };
  return { ctx, player, card, install, offered, cast };
}

describe('dangerous target builder contracts', () => {
  it('preserves established absent keys and exact spell/graveyard IR', () => {
    expect(graveyardCardTarget('controller')).toEqual({ kind: 'cardInGraveyard' });
    expect(Object.keys(graveyardCardTarget('controller'))).toEqual(['kind']);
    expect(graveyardCardTarget('opponent')).toEqual({
      kind: 'cardInGraveyard',
      graveyardOwnerScope: 'opponent',
    });
    expect(graveyardCardTarget('any', { filter: ofType('Creature') })).toEqual({
      kind: 'cardInGraveyard',
      graveyardOwnerScope: 'any',
      filter: ofType('Creature'),
    });
    expect(counterSpellTarget()).toEqual({ kind: 'spell' });
    expect(counterSpellTarget('noncreatureSpell', { controller: 'opponent' })).toEqual({
      kind: 'noncreatureSpell',
      controller: 'opponent',
    });
  });
  it.each(['controller', 'opponent', 'any'] as const)(
    'casts and resolves a %s graveyard return against actual owners',
    (owner) => {
      const state = setup();
      const own = conjure(state.ctx, 'P1', bear(), 'graveyard');
      const other = conjure(state.ctx, 'P2', bear(), 'graveyard');
      state.install(graveyardCardTarget(owner, { filter: ofType('Creature') }));
      const options = state.offered()!.targets![0]!.options;
      expect(options).toEqual(
        owner === 'controller' ? [own.id] : owner === 'opponent' ? [other.id] : [own.id, other.id],
      );
      state.cast(owner === 'controller' ? own.id : other.id);
      const selected = owner === 'controller' ? own : other;
      expect(
        state.ctx.state.players
          .find((player) => player.id === selected.ownerId)!
          .hand.some((card) => card.cardId === selected.cardId),
      ).toBe(true);
      expect(
        state.ctx.state.players
          .find((player) => player.id === selected.ownerId)!
          .graveyard.some((card) => card.cardId === selected.cardId),
      ).toBe(false);
    },
  );
  it('rejects a wrong owner response before changing state or RNG', () => {
    const state = setup();
    const own = conjure(state.ctx, 'P1', bear(), 'graveyard');
    conjure(state.ctx, 'P2', bear(), 'graveyard');
    state.install(graveyardCardTarget('opponent', { filter: ofType('Creature') }));
    const before = cloneContractContext(state.ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          state.ctx,
          state.player,
          state.offered()!.payload as PriorityActionPayload,
          { index: 0, targets: new Map([[0, own.id]]) },
        ),
      ),
    ).toThrow();
    expect(state.ctx.state).toEqual(before.state);
    expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });
  it.each(['P1', 'P2'])(
    'uses the unrestricted builder to counter an actual spell controlled by %s',
    (controllerId) => {
      const state = setup('Instant');
      const targetPlayer = state.ctx.state.players.find((player) => player.id === controllerId)!;
      const target = conjure(
        state.ctx,
        controllerId,
        oracle({
          name: 'Independent counter builder target',
          typeLine: 'Instant',
          manaCost: '{0}',
          oracleText: 'You gain 3 life.',
        }),
        'hand',
      );
      state.ctx.state.priorityPlayerIndex = state.ctx.state.turnOrder.indexOf(controllerId);
      pump(
        applyPriorityAction(
          state.ctx,
          targetPlayer,
          { kind: 'castSpell', objectId: target.id, fromCommand: false },
          { index: 0, targets: new Map() },
        ),
      );
      const spell = state.ctx.state.stack[0]!;
      state.ctx.state.priorityPlayerIndex = 0;
      const named = targetSlots({ spell: counterSpellTarget() });
      state.ctx.defs.set(state.card.oracleId, {
        ...state.ctx.defs.get(state.card.oracleId)!,
        spellAbility: {
          kind: 'spell',
          targets: named.targets,
          effects: [{ op: 'counter', target: named.slot.spell }],
        },
      });
      expect(state.offered()!.targets![0]!.options).toEqual([spell.id]);
      state.cast(spell.id);
      expect(state.ctx.state.stack).toHaveLength(0);
      expect(targetPlayer.life).toBe(40);
      expect(targetPlayer.graveyard.some((card) => card.cardId === target.cardId)).toBe(true);
    },
  );

  it('rejects an own spell when the printed builder scope requires an opponent', () => {
    const state = setup('Instant');
    const target = conjure(
      state.ctx,
      'P1',
      oracle({
        name: 'Own counter builder target',
        typeLine: 'Instant',
        manaCost: '{0}',
        oracleText: 'You gain 3 life.',
      }),
      'hand',
    );
    pump(
      applyPriorityAction(
        state.ctx,
        state.player,
        { kind: 'castSpell', objectId: target.id, fromCommand: false },
        { index: 0, targets: new Map() },
      ),
    );
    const spell = state.ctx.state.stack[0]!;
    state.ctx.state.priorityPlayerIndex = 0;
    const named = targetSlots({ spell: counterSpellTarget('spell', { controller: 'opponent' }) });
    state.ctx.defs.set(state.card.oracleId, {
      ...state.ctx.defs.get(state.card.oracleId)!,
      spellAbility: {
        kind: 'spell',
        targets: named.targets,
        effects: [{ op: 'counter', target: named.slot.spell }],
      },
    });
    const before = cloneContractContext(state.ctx);
    expect(state.offered()).toBeUndefined();
    expect(() =>
      pump(
        applyPriorityAction(
          state.ctx,
          state.player,
          { kind: 'castSpell', objectId: state.card.id, fromCommand: false },
          { index: 0, targets: new Map([[0, spell.id]]) },
        ),
      ),
    ).toThrow();
    expect(state.ctx.state).toEqual(before.state);
    expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });

  it('preserves counted groups and owner-slot references without sharing the count container', () => {
    const count = { min: 0, max: 2 };
    const first = graveyardCardTarget({ playerSlot: 0 }, { count });
    const second = graveyardCardTarget({ playerSlot: 0 }, { count });
    const named = targetSlots({ cards: first, player: { kind: 'player' } });
    expect(named.slot.player).toBe(0);
    expect(named.slot.cards).toBe(1);
    expect(named.targets[1]!.graveyardOwnerSlot).toBe(0);
    expect(first.count).not.toBe(second.count);
    expect(first.count).not.toBe(count);
  });
  it('retains prototype-named slots as ordinary numeric references', () => {
    const named = targetSlots({
      ['__proto__']: counterSpellTarget(),
      constructor: graveyardCardTarget('controller'),
      toString: { kind: 'player' },
    });
    expect(named.slot['__proto__']).toBe(0);
    expect(named.slot.constructor).toBe(1);
    expect(named.slot.toString).toBe(2);
    expect(Object.keys(named.slot)).toEqual(['__proto__', 'constructor', 'toString']);
  });
  it('does not let a builder bypass the owning ability dependency validator', () => {
    const definition = {
      ...interpretCard(bear()),
      spellAbility: {
        kind: 'spell' as const,
        targets: [graveyardCardTarget({ playerSlot: 0 })],
        effects: [{ op: 'graveyardToHand' as const, target: 0 }],
      },
    };
    expect(
      validateCardDefinition(definition).some((issue) =>
        issue.message.includes('earlier ordinary player'),
      ),
    ).toBe(true);
  });
  it.each([
    'badOwner',
    'badSlot',
    'mixedOwner',
    'badSelector',
    'badCount',
    'unknownOption',
    'permanentController',
    'spellDomain',
    'spellController',
  ] as const)('rejects invalid dangerous combinations at construction: %s', (variant) => {
    const build = () => {
      if (variant === 'badOwner') return graveyardCardTarget('you' as never);
      if (variant === 'badSlot') return graveyardCardTarget({ playerSlot: -1 });
      if (variant === 'mixedOwner')
        return graveyardCardTarget({ playerSlot: 0, scope: 'any' } as never);
      if (variant === 'badSelector')
        return graveyardCardTarget('any', { filter: { kind: 'invented' } as never });
      if (variant === 'badCount') return graveyardCardTarget('any', { count: { min: 2, max: 1 } });
      if (variant === 'unknownOption')
        return counterSpellTarget('spell', { optional: true } as never);
      if (variant === 'permanentController')
        return graveyardCardTarget('controller', { controller: 'opponent' } as never);
      if (variant === 'spellDomain') return counterSpellTarget('creature' as never);
      return counterSpellTarget('spell', { controller: 'eventPlayer' } as never);
    };
    expect(build).toThrow('target builder:');
  });
});
