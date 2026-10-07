import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import type { AbilityCost, CardDefinition } from '../src/cards/definition';
import { freeCardIsCastable, resolveFreeCard } from '../src/casting/free';
import { parseManaCost } from '../src/mana/cost';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { checkContinuations, cloneContractContext } from './helpers/contract-harness';

function setup(costs: AbilityCost[] = [], changes: Partial<CardDefinition> = {}) {
  const ctx = createGame(
    gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }], {
      seed: 'free-cast-contract',
    }),
  );
  ctx.state.activePlayerIndex = 0;
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const card = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Free cast probe',
      typeLine: 'Sorcery',
      manaCost: '{7}',
      oracleText: 'You gain 1 life.',
    }),
    'exile',
  );
  ctx.defs.set(card.oracleId, {
    ...ctx.defs.get(card.oracleId)!,
    spellAdditionalCosts: costs,
    ...changes,
  });
  return { ctx, player, card };
}

describe('shared free-casting contracts', () => {
  it('without-mana-cost command-zone casts still pay commander tax', () => {
    const { ctx, player, card } = setup();
    ctx.state.exile.splice(ctx.state.exile.indexOf(card), 1);
    card.zone = 'command';
    card.isCommander = true;
    player.commandZone.push(card);
    player.commanderCastCount[card.cardId] = 2;
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', forest());
    expect(freeCardIsCastable(ctx, card, 'P1')).toBe(false);
    spawn(ctx, 'P1', forest());
    expect(freeCardIsCastable(ctx, card, 'P1')).toBe(true);
    pump(resolveFreeCard(ctx, card, 'P1'));
    expect(player.commanderCastCount[card.cardId]).toBe(3);
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(4);
    expect(
      ctx.state.eventLog.filter((event) => event.type === 'castSpell')[0]?.payload['commanderTax'],
    ).toBe(4);
  });

  it('a missing printed mana cost can use a without-mana-cost alternative', () => {
    const { ctx, card } = setup([], { manaCost: null });
    expect(freeCardIsCastable(ctx, card, 'P1')).toBe(true);
    pump(resolveFreeCard(ctx, card, 'P1'));
    expect(ctx.state.stack[0]?.card?.cardId).toBe(card.cardId);
    expect(ctx.state.eventLog.filter((e) => e.type === 'castSpell')).toHaveLength(1);
  });

  it('mandatory life costs remain joint costs when the printed cost is free', () => {
    const { ctx, player, card } = setup([
      { kind: 'payLife', amount: 4 },
      { kind: 'payLife', amount: 4 },
    ]);
    player.life = 6;
    const before = cloneContractContext(ctx);
    expect(freeCardIsCastable(ctx, card, 'P1')).toBe(false);
    pump(resolveFreeCard(ctx, card, 'P1'));
    expect(ctx.state).toEqual(before.state);
  });

  it('pays and records optional costs through the normal cast path', () => {
    const { ctx, player, card } = setup([], {
      optionalAdditionalCost: { mechanic: 'kicker', cost: parseManaCost('{G}').cost! },
    });
    spawn(ctx, 'P1', forest());
    pump(resolveFreeCard(ctx, card, 'P1'), (decision) => ({
      index: decision.options.findIndex((o) => o.description.includes('kicker 1')),
      targets: new Map(),
    }));
    expect(ctx.state.stack[0]?.optionalCostCounts).toEqual({ kicker: 1 });
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(1);
    expect(player.manaEntries).toHaveLength(0);
    expect(ctx.state.eventLog.filter((e) => e.type === 'tapForMana')).toHaveLength(1);
  });

  it('an up-to-one counted target permits casting with no candidates', () => {
    const { ctx, card } = setup([], {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature', count: { min: 0, max: 1 } }],
        effects: [{ op: 'destroyEachChosen', targetSlot: 0 }],
      },
    });
    expect(freeCardIsCastable(ctx, card, 'P1')).toBe(true);
    pump(resolveFreeCard(ctx, card, 'P1'));
    expect(ctx.state.stack[0]?.countTargets).toEqual({ 0: [] });
  });

  it('chooses counted targets and queues ward exactly once', () => {
    const { ctx, card } = setup([], {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature', count: { min: 1, max: 1 } }],
        effects: [{ op: 'destroyEachChosen', targetSlot: 0 }],
      },
    });
    const warded = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Ward probe',
        typeLine: 'Creature',
        manaCost: '{2}',
        oracleText: 'Ward {9}',
        power: '2',
        toughness: '2',
      }),
    );
    pump(resolveFreeCard(ctx, card, 'P1'));
    expect(ctx.state.stack[0]?.countTargets).toEqual({ 0: [warded.id] });
    expect(
      ctx.state.pendingTriggers.filter((t) => t.ability.description?.startsWith('ward')),
    ).toHaveLength(1);
  });

  it('keeps modal target slot identities instead of renumbering selected targets', () => {
    const { ctx, card } = setup([], {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }, { kind: 'player' }],
        effects: [],
        modes: {
          minChoices: 1,
          maxChoices: 1,
          options: [
            { description: 'Destroy', targetSlots: [0], effects: [{ op: 'destroy', target: 0 }] },
            {
              description: 'Draw',
              targetSlots: [1],
              effects: [{ op: 'drawTarget', target: 1, count: { kind: 'const', n: 1 } }],
            },
          ],
        },
      },
    });
    pump(resolveFreeCard(ctx, card, 'P1'), (decision) => ({
      index: 0,
      targets: new Map(
        (decision.options[0]?.targets ?? []).map((slot) => [slot.slot, slot.options[0]!]),
      ),
    }));
    const stack = ctx.state.stack[0]!;
    expect(stack.targets[0]).toBeUndefined();
    expect(stack.targets[1]).toBe('P1');
  });

  it('casts another player’s card with its owner preserved', () => {
    const { ctx } = setup();
    const other = conjure(ctx, 'P2', bear(), 'graveyard');
    pump(resolveFreeCard(ctx, other, 'P1'));
    expect(ctx.state.stack[0]?.controllerId).toBe('P1');
    expect(ctx.state.stack[0]?.card?.ownerId).toBe('P2');
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === other.cardId)?.controllerId).toBe('P1');
  });

  it('global casting prohibitions apply even during a resolving permission', () => {
    const { ctx, card } = setup();
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Dragonlord Dromoka',
        typeLine: 'Legendary Creature — Elder Dragon',
        manaCost: '{4}{G}{W}',
        oracleText:
          "This spell can't be countered.\nFlying, lifelink\nYour opponents can't cast spells during your turn.",
        power: '5',
        toughness: '7',
      }),
    );
    ctx.state.currentTurnPlayer = 'P2';
    expect(freeCardIsCastable(ctx, card, 'P1')).toBe(false);
  });

  it('every advertised configuration and continuation has a payable completion', () => {
    const { ctx, card } = setup([{ kind: 'discardCard' }]);
    conjure(ctx, 'P1', bear(), 'hand');
    const proof = checkContinuations(ctx, (branch) =>
      resolveFreeCard(
        branch,
        branch.state.exile.find((c) => c.cardId === card.cardId)!,
        'P1',
      ),
    );
    expect(proof.failures).toEqual([]);
    expect(proof.completions).toBeGreaterThan(0);
  });

  it('refuses count minima that cannot fit a collective budget', () => {
    const { ctx, card } = setup([], {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature', count: { min: 2, max: 2 }, totalManaValueAtMost: 2 }],
        effects: [{ op: 'destroyEachChosen', targetSlot: 0 }],
      },
    });
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', bear());
    expect(freeCardIsCastable(ctx, card, 'P1')).toBe(false);
  });

  it('counted target menus retain only choices with a jointly affordable tax completion', () => {
    const { ctx, player, card } = setup([], {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature', count: { min: 1, max: 2 } }],
        effects: [{ op: 'destroyEachChosen', targetSlot: 0 }],
      },
    });
    player.life = 3;
    const target = spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', bear());
    ctx.defs.set(target.oracleId, {
      ...ctx.defs.get(target.oracleId)!,
      ruleStatics: [{ kind: 'targetLifeTax', amount: 3 }],
    });
    const proof = checkContinuations(ctx, (branch) =>
      resolveFreeCard(
        branch,
        branch.state.exile.find((c) => c.cardId === card.cardId)!,
        'P1',
      ),
    );
    expect(proof.failures).toEqual([]);
    expect(proof.completions).toBe(2);
    pump(resolveFreeCard(ctx, card, 'P1'));
    expect(ctx.state.stack[0]?.countTargets?.[0]).toHaveLength(1);
    expect(player.life).toBe(0);
  });

  it('different targeting occurrences may select the same object and trigger ward once', () => {
    const { ctx, card } = setup([], {
      spellAbility: {
        kind: 'spell',
        targets: [
          { kind: 'creature', count: { min: 1, max: 1 } },
          { kind: 'creature', count: { min: 1, max: 1 } },
        ],
        effects: [
          { op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 },
          { op: 'putCountersEachChosen', targetSlot: 1, counter: '+1/+1', count: 1 },
        ],
      },
    });
    const target = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Repeated ward probe',
        typeLine: 'Creature',
        manaCost: '{2}',
        oracleText: 'Ward {9}',
        power: '2',
        toughness: '2',
      }),
    );
    expect(freeCardIsCastable(ctx, card, 'P1')).toBe(true);
    pump(resolveFreeCard(ctx, card, 'P1'));
    expect(ctx.state.stack[0]?.countTargets).toEqual({ 0: [target.id], 1: [target.id] });
    expect(
      ctx.state.pendingTriggers.filter((t) => t.ability.description?.startsWith('ward')),
    ).toHaveLength(1);
    pump(resolveTopOfStack(ctx));
    expect(target.counters['+1/+1']).toBe(2);
  });

  it('a permission cannot cast a stale object with the same physical card identity', () => {
    const { ctx, card } = setup();
    const before = cloneContractContext(ctx);
    const stale = { ...card };
    expect(freeCardIsCastable(ctx, stale, 'P1')).toBe(false);
    pump(resolveFreeCard(ctx, stale, 'P1'));
    expect(ctx.state).toEqual(before.state);
    expect(freeCardIsCastable(ctx, card, 'P1')).toBe(true);
  });

  it.each(['missing', 'illegal', 'extra'] as const)(
    'rejects a %s free-cast target response before creating a proposal',
    (kind) => {
      const { ctx, card } = setup([], {
        spellAbility: {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'putCounters', target: 0, counter: '+1/+1', count: 1 }],
        },
      });
      const target = spawn(ctx, 'P2', bear());
      const before = cloneContractContext(ctx);
      const flow = resolveFreeCard(ctx, card, 'P1');
      expect(flow.next().done).toBe(false);
      const response =
        kind === 'missing'
          ? new Map()
          : kind === 'illegal'
            ? new Map([[0, 'P2']])
            : new Map([
                [0, target.id],
                [999, target.id],
              ]);
      expect(() => flow.next({ index: 0, targets: response })).toThrow(
        'invalid free-cast target response',
      );
      expect(ctx.state).toEqual(before.state);
      expect(ctx.debugLog).toEqual(before.debugLog);
    },
  );

  it('a direct casting request cannot bypass explicit unsupported behavior', () => {
    const { ctx, player, card } = setup([], {
      modeled: false,
      unmodeledReasons: ['Unsupported primitive contract'],
    });
    const before = cloneContractContext(ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: card.id, fromCommand: false, fromExile: true },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow('Unsupported primitive contract');
    expect(ctx.state).toEqual(before.state);
  });

  it.each([
    { x: -1 },
    { x: 0.5 },
    { optionalCostCount: Infinity },
    { fromExile: true, fromGraveyard: true },
  ])('rejects malformed normal casting before mutation: %j', (configuration) => {
    const { ctx, player, card } = setup();
    const before = cloneContractContext(ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: card.id, fromCommand: false, ...configuration },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow();
    expect(ctx.state).toEqual(before.state);
  });
});
