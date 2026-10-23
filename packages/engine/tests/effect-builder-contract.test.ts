import { describe, expect, it } from 'vitest';
import type { Effect, TargetSpec } from '../src/cards/ability';
import {
  castWithoutManaCost,
  exileUntilThisSourceLeaves,
  graveyardAlternativeCost,
  graveyardCardTarget,
  playLinkedExiledCardWithoutManaCost,
  returnGraveyardCard,
  searchLibraryCards,
} from '../src/cards/templates';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { ofType } from '../src/cards/selector';
import { parseManaCost } from '../src/mana/cost';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function setup(effects: Effect[], targets: TargetSpec[] = []) {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const card = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Independent dangerous effect builder spell',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  const definition = {
    ...ctx.defs.get(card.oracleId)!,
    spellAbility: { kind: 'spell' as const, targets, effects },
  };
  expect(validateCardDefinition(definition)).toEqual([]);
  ctx.defs.set(card.oracleId, definition);
  const cast = (targetIds = new Map<number, string>()) => {
    const option = computePriorityOptions(ctx, player).find(
      (option) => (option.payload as { objectId?: string }).objectId === card.id,
    )!;
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option.payload as PriorityActionPayload, {
        index: 0,
        targets: targetIds,
      }),
    );
    pump(resolveTopOfStack(ctx));
  };
  return { ctx, player, card, cast };
}

describe('dangerous effect builders preserve independently executed contracts', () => {
  it('preserves absent keys and independent search destination containers', () => {
    const destinations = [{ zone: 'hand' as const }];
    const effect = searchLibraryCards(ofType('Creature'), destinations);
    expect(effect).toEqual({ op: 'searchLibrary', filter: ofType('Creature'), destinations });
    expect(Object.keys(effect)).toEqual(['op', 'filter', 'destinations']);
    if (effect.op !== 'searchLibrary') throw new Error('wrong envelope');
    expect(effect.destinations).not.toBe(destinations);
    expect(effect.destinations[0]).not.toBe(destinations[0]);
    expect(castWithoutManaCost({ from: 'hand' })).toEqual({ op: 'castAnyFromHandFree' });
    expect(playLinkedExiledCardWithoutManaCost()).toEqual({ op: 'playExiledCardFree' });
    const cost = parseManaCost('{G}').cost!;
    expect(
      graveyardAlternativeCost('flashback', cost, { description: 'Flashback {G}', costs: [] }),
    ).toEqual({
      kind: 'nonMana',
      from: 'graveyard',
      manaCost: cost,
      exileOnResolution: true,
      description: 'Flashback {G}',
    });
    expect(graveyardAlternativeCost('escape', cost, { description: 'Escape {G}' })).toEqual({
      kind: 'nonMana',
      from: 'graveyard',
      manaCost: cost,
      escaped: true,
      description: 'Escape {G}',
    });
  });
  it.each(['battlefield', 'hand', 'libraryTop'] as const)(
    'returns an opponent-owned graveyard card to %s through normal casting',
    (destination) => {
      const state = setup(
        [returnGraveyardCard(0, destination)],
        [graveyardCardTarget('any', { filter: ofType('Creature') })],
      );
      const target = conjure(state.ctx, 'P2', bear(), 'graveyard');
      state.cast(new Map([[0, target.id]]));
      expect(
        state.ctx.state.players[1]!.graveyard.some((card) => card.cardId === target.cardId),
      ).toBe(false);
      if (destination === 'battlefield')
        expect(
          state.ctx.state.battlefield.find((card) => card.cardId === target.cardId),
        ).toMatchObject({ controllerId: 'P1', ownerId: 'P2' });
      else
        expect(
          (destination === 'hand'
            ? state.ctx.state.players[1]!.hand
            : state.ctx.state.players[1]!.library
          ).some((card) => card.cardId === target.cardId),
        ).toBe(true);
    },
  );
  it('searches privately for an eligible card without treating it as a battlefield target', () => {
    const state = setup([
      searchLibraryCards(ofType('Creature'), [{ zone: 'hand' }], { reveal: true }),
    ]);
    const selected = conjure(
      state.ctx,
      'P1',
      oracle({
        name: 'Independent shroud search creature',
        typeLine: 'Creature — Bear',
        power: '2',
        toughness: '2',
        oracleText: 'Shroud',
      }),
      'library',
    );
    state.cast();
    expect(state.player.hand.some((card) => card.cardId === selected.cardId)).toBe(true);
    expect(
      state.ctx.state.eventLog.some(
        (event) => event.type === 'searchFound' && event.payload['revealed'] === true,
      ),
    ).toBe(true);
    expect(state.ctx.state.eventLog.some((event) => event.type === 'becomesTargeted')).toBe(false);
  });
  it.each(['hand', 'librarySearch'] as const)(
    'casts a seven-mana spell without its mana cost from %s, retaining an additional life cost',
    (from) => {
      const state = setup([
        from === 'hand'
          ? castWithoutManaCost({ from })
          : castWithoutManaCost({ from, filter: ofType('Instant') }),
      ]);
      const child = conjure(
        state.ctx,
        'P1',
        oracle({
          name: 'Independent free child',
          typeLine: 'Instant',
          manaCost: '{7}',
          oracleText: 'You gain 1 life.',
        }),
        from === 'hand' ? 'hand' : 'library',
      );
      state.ctx.defs.set(child.oracleId, {
        ...state.ctx.defs.get(child.oracleId)!,
        spellAdditionalCosts: [{ kind: 'payLife', amount: 3 }],
      });
      state.cast();
      expect(state.ctx.state.stack).toHaveLength(1);
      expect(state.ctx.state.stack[0]!.card?.cardId).toBe(child.cardId);
      expect(state.player.life).toBe(37);
      expect(state.ctx.state.eventLog.filter((event) => event.type === 'castSpell')).toHaveLength(
        2,
      );
      pump(resolveTopOfStack(state.ctx));
      expect(state.player.life).toBe(38);
    },
  );
  it.each(['flashback', 'escape'] as const)(
    'casts a guarded %s alternative and uses its own destination',
    (mechanic) => {
      const state = setup([]);
      const child = conjure(
        state.ctx,
        'P1',
        oracle({
          name: 'Independent graveyard-cost child',
          typeLine: 'Instant',
          manaCost: '{7}',
          oracleText: 'You gain 1 life.',
        }),
        'graveyard',
      );
      const definition = {
        ...state.ctx.defs.get(child.oracleId)!,
        alternativeCasts: [
          graveyardAlternativeCost(mechanic, parseManaCost('{0}').cost!, { description: mechanic }),
        ],
      };
      expect(validateCardDefinition(definition)).toEqual([]);
      state.ctx.defs.set(child.oracleId, definition);
      const option = computePriorityOptions(state.ctx, state.player).find(
        (option) =>
          (
            option.payload as {
              objectId?: string;
              fromGraveyard?: boolean;
              alternativeCast?: string;
            }
          ).objectId === child.id &&
          (option.payload as { alternativeCast?: string }).alternativeCast === 'nonMana',
      )!;
      expect(option).toBeDefined();
      pump(
        applyPriorityAction(state.ctx, state.player, option.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
      );
      expect(state.ctx.state.stack[0]!.escaped === true).toBe(mechanic === 'escape');
      pump(resolveTopOfStack(state.ctx));
      expect(
        (mechanic === 'flashback' ? state.ctx.state.exile : state.player.graveyard).some(
          (card) => card.cardId === child.cardId,
        ),
      ).toBe(true);
      expect(state.player.life).toBe(41);
    },
  );
  it('links an activated exile to the original battlefield source and returns it when that source leaves', () => {
    const state = setup([]);
    const source = spawn(
      state.ctx,
      'P1',
      oracle({ name: 'Independent linked exile source', typeLine: 'Artifact' }),
    );
    const target = spawn(state.ctx, 'P2', bear());
    state.ctx.defs.set(source.oracleId, {
      ...state.ctx.defs.get(source.oracleId)!,
      activatedAbilities: [
        {
          timing: 'any',
          costs: [],
          ability: {
            kind: 'activated',
            targets: [{ kind: 'creature' }],
            effects: [exileUntilThisSourceLeaves(0)],
          },
        },
      ],
    });
    pump(
      applyPriorityAction(
        state.ctx,
        state.player,
        { kind: 'activateAbility', objectId: source.id, index: 0 },
        { index: 0, targets: new Map([[0, target.id]]) },
      ),
    );
    pump(resolveTopOfStack(state.ctx));
    expect(state.ctx.state.exile.some((card) => card.cardId === target.cardId)).toBe(true);
    const removal = conjure(
      state.ctx,
      'P1',
      oracle({
        name: 'Independent remove source spell',
        typeLine: 'Instant',
        manaCost: '{0}',
        oracleText: 'Destroy target artifact.',
      }),
      'hand',
    );
    pump(
      applyPriorityAction(
        state.ctx,
        state.player,
        { kind: 'castSpell', objectId: removal.id, fromCommand: false },
        { index: 0, targets: new Map([[0, source.id]]) },
      ),
    );
    pump(resolveTopOfStack(state.ctx));
    const returned = state.ctx.state.battlefield.find((card) => card.cardId === target.cardId)!;
    expect(returned.id).not.toBe(target.id);
    expect(returned.controllerId).toBe('P2');
    expect(state.ctx.state.exile.some((card) => card.cardId === target.cardId)).toBe(false);
  });
  it.each([
    () => returnGraveyardCard(-1, 'hand'),
    () => returnGraveyardCard(0, 'exile' as never),
    () => exileUntilThisSourceLeaves(0.5),
    () => castWithoutManaCost({ from: 'graveyard' } as never),
    () => castWithoutManaCost({ from: 'hand', maxManaValue: -1 }),
    () => castWithoutManaCost({ from: 'librarySearch', filter: { kind: 'invented' } } as never),
    () => searchLibraryCards(ofType('Creature'), []),
    () => searchLibraryCards(ofType('Creature'), [{ zone: 'hand', tapped: true }]),
    () => searchLibraryCards(ofType('Creature'), [{ zone: 'hand' }], { count: 1.5 }),
    () => searchLibraryCards(ofType('Creature'), [{ zone: 'hand' }], { bind: '' }),
    () =>
      graveyardAlternativeCost('escape', parseManaCost('{G}').cost!, {
        description: 'Escape',
        costs: [{ kind: 'imaginary' } as never],
      }),
    () =>
      graveyardAlternativeCost('flashback', parseManaCost('{G}').cost!, {
        description: 'Flashback',
        escaped: true,
      } as never),
  ])('rejects a malformed dangerous envelope before it can be composed: %s', (build) => {
    expect(build).toThrow('effect builder:');
  });
});

describe('dangerous builder composition boundaries', () => {
  it.each([true, false])(
    'linked exile retains owner and mandatory cost while its controller chooses free play: accept=%s',
    (accept) => {
      const state = setup([]);
      const source = spawn(
        state.ctx,
        'P1',
        oracle({ name: 'Independent linked free-play source', typeLine: 'Artifact' }),
      );
      const child = conjure(
        state.ctx,
        'P2',
        oracle({
          name: 'Independent linked child',
          typeLine: 'Sorcery',
          manaCost: '{7}',
          oracleText: 'You gain 1 life.',
        }),
        'exile',
      );
      child.attachedToCardId = source.cardId;
      child.attachedToObjectId = source.id;
      state.ctx.defs.set(child.oracleId, {
        ...state.ctx.defs.get(child.oracleId)!,
        spellAdditionalCosts: [{ kind: 'payLife', amount: 3 }],
      });
      state.ctx.defs.set(source.oracleId, {
        ...state.ctx.defs.get(source.oracleId)!,
        activatedAbilities: [
          {
            timing: 'any',
            costs: [],
            ability: {
              kind: 'activated',
              targets: [],
              effects: [playLinkedExiledCardWithoutManaCost()],
            },
          },
        ],
      });
      pump(
        applyPriorityAction(
          state.ctx,
          state.player,
          { kind: 'activateAbility', objectId: source.id, index: 0 },
          { index: 0, targets: new Map() },
        ),
      );
      pump(resolveTopOfStack(state.ctx), (decision) => ({
        index: accept ? 0 : decision.options.findIndex((option) => option.type === 'decline'),
        targets: new Map(),
      }));
      if (accept) {
        expect(state.ctx.state.stack[0]).toMatchObject({
          controllerId: 'P1',
          card: { cardId: child.cardId, ownerId: 'P2' },
        });
        expect(state.player.life).toBe(37);
        pump(resolveTopOfStack(state.ctx));
        expect(state.player.life).toBe(38);
        expect(
          state.ctx.state.players[1]!.graveyard.some((card) => card.cardId === child.cardId),
        ).toBe(true);
      } else {
        expect(state.ctx.state.stack).toEqual([]);
        expect(state.player.life).toBe(40);
        expect(
          state.ctx.state.exile.find((card) => card.cardId === child.cardId)?.attachedToCardId,
        ).toBe(source.cardId);
        expect(state.ctx.state.eventLog.some((event) => event.type === 'castSpell')).toBe(false);
      }
    },
  );
  it.each(['stale', 'missing'] as const)(
    'linked free play rejects a %s source incarnation despite the same physical card ID',
    (link) => {
      const state = setup([]);
      const source = spawn(
        state.ctx,
        'P1',
        oracle({ name: 'Independent exact linked source', typeLine: 'Artifact' }),
      );
      const child = conjure(
        state.ctx,
        'P2',
        oracle({
          name: 'Independent exact linked child',
          typeLine: 'Sorcery',
          manaCost: '{7}',
          oracleText: 'You gain 1 life.',
        }),
        'exile',
      );
      child.attachedToCardId = source.cardId;
      if (link === 'stale') child.attachedToObjectId = 'prior-source-incarnation';
      state.ctx.defs.set(source.oracleId, {
        ...state.ctx.defs.get(source.oracleId)!,
        activatedAbilities: [
          {
            timing: 'any',
            costs: [],
            ability: {
              kind: 'activated',
              targets: [],
              effects: [playLinkedExiledCardWithoutManaCost()],
            },
          },
        ],
      });
      pump(
        applyPriorityAction(
          state.ctx,
          state.player,
          { kind: 'activateAbility', objectId: source.id, index: 0 },
          { index: 0, targets: new Map() },
        ),
      );
      const result = pump(resolveTopOfStack(state.ctx));
      expect(result.decisions).toEqual([]);
      expect(state.ctx.state.stack).toEqual([]);
      expect(state.ctx.state.exile).toContain(child);
      expect(child.ownerId).toBe('P2');
      expect(state.player.life).toBe(40);
      expect(state.ctx.state.eventLog.some((event) => event.type === 'castSpell')).toBe(false);
    },
  );

  it('a free-cast bound does not change the selected card mana value to make it fit', () => {
    const state = setup([castWithoutManaCost({ from: 'hand', maxManaValue: 1 })]);
    const child = conjure(
      state.ctx,
      'P1',
      oracle({
        name: 'Outside free-cast bound',
        typeLine: 'Instant',
        manaCost: '{7}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    state.cast();
    expect(state.player.hand.some((card) => card.cardId === child.cardId)).toBe(true);
    expect(state.ctx.state.stack).toEqual([]);
    expect(state.ctx.state.eventLog.filter((event) => event.type === 'castSpell')).toHaveLength(1);
  });
  it('searches for different names as card choices with independent destination selections', () => {
    const state = setup([
      searchLibraryCards(ofType('Creature'), [{ zone: 'hand' }, { zone: 'hand' }], {
        differentNames: true,
      }),
    ]);
    conjure(state.ctx, 'P1', bear(), 'library');
    conjure(state.ctx, 'P1', bear(), 'library');
    conjure(
      state.ctx,
      'P1',
      oracle({
        name: 'Other independent creature',
        typeLine: 'Creature',
        power: '1',
        toughness: '1',
      }),
      'library',
    );
    state.cast();
    expect(state.player.hand.map((card) => card.name).sort()).toEqual([
      'Other independent creature',
      'Test Bear',
    ]);
  });
  it('a return builder cannot bypass the owning ability target domain', () => {
    const state = setup([]);
    const invalid = {
      ...state.ctx.defs.get(state.card.oracleId)!,
      spellAbility: {
        kind: 'spell' as const,
        targets: [{ kind: 'player' as const }],
        effects: [returnGraveyardCard(0, 'hand')],
      },
    };
    expect(
      validateCardDefinition(invalid).some((issue) => issue.message.includes('incompatible')),
    ).toBe(true);
  });
});
