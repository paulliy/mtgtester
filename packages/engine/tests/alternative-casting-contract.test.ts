import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { CardDefinition } from '../src/cards/definition';
import { manaCost, spell } from '../src/cards/templates';
import type { EngineActionOption } from '../src/decisions';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { checkContinuations, cloneContractContext } from './helpers/contract-harness';

type CastPayload = Extract<PriorityActionPayload, { kind: 'castSpell' }>;
function setup(changes: Partial<CardDefinition> = {}, printedCost: string | null = '{99}') {
  const ctx = createGame(
    gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }], {
      seed: 'alternative-contract',
    }),
  );
  const player = ctx.state.players[0]!;
  ctx.state.currentTurnPlayer = player.id;
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const card = conjure(
    ctx,
    player.id,
    oracle({
      name: 'Alternative cast probe',
      typeLine: 'Sorcery',
      manaCost: printedCost,
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  ctx.defs.set(card.oracleId, { ...ctx.defs.get(card.oracleId)!, ...changes });
  const options = () =>
    computePriorityOptions(ctx, player).filter(
      (option) =>
        (option.payload as CastPayload).kind === 'castSpell' &&
        (option.payload as CastPayload).objectId === card.id,
    );
  const cast = (option: EngineActionOption, targets = new Map()) =>
    pump(applyPriorityAction(ctx, player, option.payload as CastPayload, { index: 0, targets }));
  const lands = (count: number) =>
    Array.from({ length: count }, () => spawn(ctx, player.id, forest()));
  return { ctx, player, card, options, cast, lands };
}
const nonMana = (cost = '{0}') => ({
  kind: 'nonMana' as const,
  manaCost: manaCost(cost),
  description: 'Alternative payment',
});

describe('independent alternative casting contracts', () => {
  it('a hand alternative pays its own mana component rather than becoming free', () => {
    const { ctx, options, cast, lands } = setup({ alternativeCasts: [nonMana('{2}')] });
    const first = lands(1)[0]!;
    expect(options()).toEqual([]);
    const second = lands(1)[0]!;
    const option = options()[0]!;
    expect(option.data?.['manaCost']).toBe('{2}');
    cast(option);
    expect(first.tapped && second.tapped).toBe(true);
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(2);
  });

  it('a card without a printed mana cost can use an affordable alternative', () => {
    const { ctx, options, cast } = setup({ alternativeCasts: [nonMana()] }, null);
    expect(options()).toHaveLength(1);
    cast(options()[0]!);
    expect(ctx.state.stack).toHaveLength(1);
  });

  it('alternative casts announce modes and pay both mode and optional additional costs', () => {
    const { ctx, options, cast, lands } = setup({
      alternativeCasts: [nonMana('{1}')],
      optionalAdditionalCost: { mechanic: 'kicker', cost: manaCost('{1}') },
      spellAbility: spell({
        effects: [],
        modes: {
          minChoices: 1,
          maxChoices: 1,
          options: [
            {
              description: 'Gain life',
              targetSlots: [],
              additionalCost: [{ kind: 'mana', cost: manaCost('{1}') }],
              effects: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
            },
            {
              description: 'Draw',
              targetSlots: [],
              effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
            },
          ],
        },
      }),
    });
    lands(3);
    const option = options().find((entry) => {
      const payload = entry.payload as CastPayload;
      return payload.modes?.[0] === 0 && payload.optionalCostCount === 1;
    })!;
    expect(option).toBeDefined();
    cast(option);
    expect(ctx.state.stack[0]?.ability?.effects).toEqual([
      { op: 'gainLife', amount: { kind: 'const', n: 3 } },
    ]);
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(3);
    expect(ctx.state.stack[0]?.optionalCostCounts).toEqual({ kicker: 1 });
  });

  it.each(['energy', 'nonMana', 'overload'] as const)(
    '%s retains commander tax in preview and application',
    (kind) => {
      const { ctx, player, card, options, cast, lands } = setup({
        types: ['Creature'],
        alternativeCasts:
          kind === 'energy'
            ? []
            : [
                {
                  ...nonMana(),
                  kind,
                  ...(kind === 'overload' ? { ability: spell({ effects: [] }) } : {}),
                },
              ],
      });
      player.hand.splice(0, 1);
      card.zone = 'command';
      card.isCommander = true;
      player.commandZone.push(card);
      player.commanderCardIds.push(card.cardId);
      player.commanderCastCount[card.cardId] = 2;
      if (kind === 'energy') {
        const grant = spawn(
          ctx,
          player.id,
          oracle({ name: 'Energy cost grant', typeLine: 'Enchantment' }),
        );
        ctx.defs.set(grant.oracleId, {
          ...ctx.defs.get(grant.oracleId)!,
          energyAlternativeCost: 3,
        });
        player.energy = 3;
      }
      lands(3);
      expect(options()).toEqual([]);
      lands(1);
      const option = options()[0]!;
      expect(option.data?.['commanderTax']).toBe(4);
      cast(option);
      expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(4);
      expect(player.commanderCastCount[card.cardId]).toBe(3);
      if (kind === 'energy') expect(player.energy).toBe(0);
    },
  );

  it('an instant Omen is offered outside the main face’s timing and uses its own targets', () => {
    const ability = spell({
      targets: [{ kind: 'creature', controller: 'opponent' }],
      effects: [{ op: 'returnToHand', target: 0 }],
    });
    const { ctx, options, cast } = setup({
      types: ['Creature'],
      spellAbility: null,
      alternativeCasts: [
        {
          kind: 'omen',
          manaCost: manaCost('{0}'),
          description: 'Omen face',
          spellFace: {
            ...interpretCard(
              oracle({
                name: 'Omen face',
                typeLine: 'Instant — Omen',
                manaCost: '{0}',
                oracleText: 'You gain 1 life.',
              }),
            ),
            spellAbility: ability,
          },
          typeLine: 'Instant — Omen',
          ability,
        },
      ],
    });
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.phase = 'combat';
    const own = spawn(ctx, 'P1', bear());
    const other = spawn(ctx, 'P2', bear());
    const option = options()[0]!;
    expect(option.targets?.[0]?.options).toEqual([other.id]);
    expect(option.targets?.[0]?.options).not.toContain(own.id);
    cast(option, new Map([[0, other.id]]));
    expect(ctx.state.stack[0]?.ability).toEqual(ability);
    expect(ctx.state.stack[0]?.targets).toEqual([other.id]);
    expect(ctx.state.stack[0]?.altIndex).toBe(0);
  });

  it('a malformed alternate index is rejected without changing the complete context', () => {
    const { ctx, player, card } = setup({ alternativeCasts: [nonMana()] });
    const before = cloneContractContext(ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          {
            kind: 'castSpell',
            objectId: card.id,
            fromCommand: false,
            alternativeCast: 'nonMana',
            altIndex: 999,
          },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow();
    expect(ctx.state).toEqual(before.state);
    expect(ctx.debugLog).toEqual(before.debugLog);
    expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });

  it('rejects an undeclared target slot rather than silently ignoring the response', () => {
    const { ctx, player, card } = setup({ alternativeCasts: [nonMana()] });
    const before = cloneContractContext(ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          {
            kind: 'castSpell',
            objectId: card.id,
            fromCommand: false,
            alternativeCast: 'nonMana',
            altIndex: 0,
          },
          { index: 0, targets: new Map([[999, player.id]]) },
        ),
      ),
    ).toThrow('unexpected ordinary target slot');
    expect(ctx.state).toEqual(before.state);
  });

  it('a forged response cannot target the proposed spell itself', () => {
    const { ctx, player, card } = setup({
      alternativeCasts: [nonMana()],
      spellAbility: spell({
        targets: [{ kind: 'spell' }],
        effects: [{ op: 'counter', target: 0 }],
      }),
    });
    const before = cloneContractContext(ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          {
            kind: 'castSpell',
            objectId: card.id,
            fromCommand: false,
            alternativeCast: 'nonMana',
            altIndex: 0,
          },
          { index: 0, targets: new Map([[0, `o-${ctx.state.nextObjectNum}`]]) },
        ),
      ),
    ).toThrow('illegal target');
    expect(ctx.state).toEqual(before.state);
  });

  it('alternative target menus retain the joint life budget for every advertised assignment', () => {
    const { ctx, player, options } = setup({
      alternativeCasts: [nonMana()],
      spellAbility: spell({
        targets: [
          { kind: 'creature', controller: 'opponent' },
          { kind: 'creature', controller: 'opponent' },
        ],
        effects: [
          { op: 'destroy', target: 0 },
          { op: 'destroy', target: 1 },
        ],
      }),
    });
    player.life = 3;
    const target = spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', bear());
    ctx.defs.set(target.oracleId, {
      ...ctx.defs.get(target.oracleId)!,
      ruleStatics: [{ kind: 'targetLifeTax', amount: 3 }],
    });
    expect(options()).toHaveLength(2);
    for (const option of options()) {
      const result = checkContinuations(ctx, function* (copy) {
        const outcome = yield {
          decisionType: 'priority',
          player: player.id,
          prompt: 'Independent alternative tax assignment',
          options: [option],
        };
        yield* applyPriorityAction(
          copy,
          copy.state.players[0]!,
          option.payload as CastPayload,
          outcome,
        );
      });
      expect(result.failures).toEqual([]);
      expect(result.completions).toBe(1);
    }
  });

  it('every advertised alternative payment continuation applies independently', () => {
    const { ctx, options, lands } = setup({
      alternativeCasts: [nonMana()],
      optionalAdditionalCost: { mechanic: 'kicker', cost: manaCost('{1}') },
      spellAdditionalCosts: [{ kind: 'discardCard' }],
    });
    lands(1);
    conjure(ctx, 'P1', bear(), 'hand');
    conjure(ctx, 'P1', bear(), 'hand');
    for (const option of options()) {
      const result = checkContinuations(ctx, (copy) =>
        applyPriorityAction(copy, copy.state.players[0]!, option.payload as CastPayload, {
          index: 0,
          targets: new Map(),
        }),
      );
      expect(result.failures).toEqual([]);
      expect(result.completions).toBeGreaterThan(0);
    }
  });
});

describe('casting configuration source permissions', () => {
  it('selects the requested face for timing when its index is omitted', () => {
    const { ctx, player, card, lands } = setup({
      alternativeCasts: [
        nonMana(),
        {
          kind: 'omen',
          name: 'Instant probe',
          typeLine: 'Instant — Omen',
          manaCost: manaCost('{1}'),
          description: 'Instant probe',
          spellFace: interpretCard(
            oracle({
              name: 'Instant probe',
              typeLine: 'Instant — Omen',
              manaCost: '{1}',
              oracleText: 'You gain 1 life.',
            }),
          ),
          ability: spell({ effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }] }),
        },
      ],
    });
    lands(1);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.phase = 'combat';
    pump(
      applyPriorityAction(
        ctx,
        player,
        { kind: 'castSpell', objectId: card.id, fromCommand: false, alternativeCast: 'omen' },
        { index: 0, targets: new Map() },
      ),
    );
    expect(ctx.state.stack[0]?.alternativeCastKind).toBe('omen');
  });

  it('rejects an alternative index on a normal spell instead of ignoring it', () => {
    const { ctx, player, card } = setup({}, '{0}');
    const before = cloneContractContext(ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: card.id, fromCommand: false, altIndex: 0 },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow('unexpected alternative index');
    expect(ctx.state).toEqual(before.state);
  });

  it('does not offer an exile-only alternative from the hand', () => {
    const { ctx, player, card, options } = setup({
      alternativeCasts: [{ ...nonMana(), from: 'exile' }],
    });
    expect(options()).toEqual([]);
    const before = cloneContractContext(ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          {
            kind: 'castSpell',
            objectId: card.id,
            fromCommand: false,
            alternativeCast: 'nonMana',
            altIndex: 0,
          },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow('not supported from this zone');
    expect(ctx.state).toEqual(before.state);
  });

  it('cannot use another owner’s Adventure permission', () => {
    const { ctx, player, card } = setup({}, '{0}');
    player.hand.splice(player.hand.indexOf(card), 1);
    card.zone = 'exile';
    card.ownerId = 'P2';
    card.onAdventure = true;
    ctx.state.exile.push(card);
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
    ).toThrow('exile cast permission');
    expect(ctx.state).toEqual(before.state);
  });

  it('an alternative cost does not grant casting from the top of the library', () => {
    const { ctx, player, card } = setup({ types: ['Artifact'] });
    const grant = spawn(
      ctx,
      player.id,
      oracle({ name: 'Energy permission probe', typeLine: 'Enchantment' }),
    );
    ctx.defs.set(grant.oracleId, { ...ctx.defs.get(grant.oracleId)!, energyAlternativeCost: 3 });
    player.energy = 3;
    player.hand.splice(player.hand.indexOf(card), 1);
    card.zone = 'library';
    player.library.unshift(card);
    const before = cloneContractContext(ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          {
            kind: 'castSpell',
            objectId: card.id,
            fromCommand: false,
            fromLibraryTop: true,
            alternativeCast: 'energy',
          },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow('cast from library top is not legal');
    expect(ctx.state).toEqual(before.state);
  });

  it('alternative casting consumes the selected source-zone budget', () => {
    const { ctx, player, card, options, cast } = setup({ types: ['Artifact'] });
    const grant = spawn(
      ctx,
      player.id,
      oracle({ name: 'Energy budget probe', typeLine: 'Enchantment' }),
    );
    ctx.defs.set(grant.oracleId, {
      ...ctx.defs.get(grant.oracleId)!,
      energyAlternativeCost: 3,
      ruleStatics: [{ kind: 'playFromZone', zone: 'libraryTop', permanentTypeBudget: 1 }],
    });
    player.energy = 3;
    player.hand.splice(player.hand.indexOf(card), 1);
    card.zone = 'library';
    player.library.unshift(card);
    const option = options().find(
      (option) => (option.payload as CastPayload).alternativeCast === 'energy',
    )!;
    expect((option.payload as CastPayload).zoneBudgetType).toBe('Artifact');
    cast(option);
    expect(player.playFromZoneTypeUsesThisTurn).toEqual({ Artifact: 1 });
    expect(player.energy).toBe(0);
  });
});

it('a permitted normal graveyard cast reports the actual source zone', () => {
  const state = setup({}, '{0}');
  state.player.hand = state.player.hand.filter((card) => card !== state.card);
  state.card.zone = 'graveyard';
  state.player.graveyard.push(state.card);
  const grant = spawn(
    state.ctx,
    'P1',
    oracle({ name: 'Independent graveyard permission', typeLine: 'Enchantment' }),
  );
  state.ctx.defs.set(grant.oracleId, {
    ...state.ctx.defs.get(grant.oracleId)!,
    ruleStatics: [{ kind: 'playFromZone', zone: 'graveyard' }],
  });
  const option = state.options()[0]!;
  expect(option.data?.['sourceZone']).toBe('graveyard');
  expect(option.description).toContain('graveyard');
  state.cast(option);
  expect(state.ctx.state.stack).toHaveLength(1);
  expect(state.player.graveyard).toHaveLength(0);
});
