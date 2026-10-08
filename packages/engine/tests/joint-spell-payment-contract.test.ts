import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  canPaySpellAdditionalCosts,
  computePriorityOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import type { AbilityCost } from '../src/cards/ability';
import { ofType } from '../src/cards/selector';
import { emptyCost, parseManaCost } from '../src/mana/cost';
import { planSpellPayment } from '../src/mana/spell-payment';
import { createGame } from '../src/state/game';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { checkContinuations, cloneContractContext } from './helpers/contract-harness';

function setup(costs: AbilityCost[], manaCost = '{0}') {
  const ctx = createGame(
    gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }], {
      seed: 'joint-payment',
    }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const player = ctx.state.players[0]!;
  const spell = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Joint cost probe',
      typeLine: 'Sorcery',
      manaCost,
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  const def = ctx.defs.get(spell.oracleId)!;
  ctx.defs.set(spell.oracleId, { ...def, spellAdditionalCosts: costs });
  const request = {
    mana: parseManaCost(manaCost).cost!,
    costs,
    sourceCardId: spell.cardId,
    sourceOracleId: spell.oracleId,
    sourceIsCommander: false,
  };
  const offered = () =>
    computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
  const cast = () => {
    const option = offered();
    expect(option).toBeDefined();
    return pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
  };
  return { ctx, player, spell, request, offered, cast };
}

describe('independent combined spell-payment contracts', () => {
  it('six life cannot pay two four-life costs, and rejection does not mutate the context', () => {
    const { ctx, player, spell, request, offered } = setup([
      { kind: 'payLife', amount: 4 },
      { kind: 'payLife', amount: 4 },
    ]);
    player.life = 6;
    const before = cloneContractContext(ctx);
    expect(planSpellPayment(ctx, player, request)).toBeNull();
    expect(canPaySpellAdditionalCosts(ctx, player, request.costs, spell.cardId, true)).toBe(false);
    expect(offered()).toBeUndefined();
    expect(ctx.state).toEqual(before.state);
    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: spell.id, fromCommand: false },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow('not jointly payable');
    expect(ctx.state).toEqual(before.state);
  });

  it('Phyrexian mana and additional life costs share the same budget', () => {
    const { player, offered, cast } = setup([{ kind: 'payLife', amount: 4 }], '{G/P}');
    player.life = 5;
    expect(offered()).toBeUndefined();
    player.life = 6;
    cast();
    expect(player.life).toBe(0);
  });

  it('actual target taxes share the remaining life budget', () => {
    const { ctx, player, request } = setup([{ kind: 'payLife', amount: 4 }], '{G/P}');
    player.life = 7;
    expect(planSpellPayment(ctx, player, { ...request, targetLifeTax: 2 })).toBeNull();
    player.life = 8;
    expect(planSpellPayment(ctx, player, { ...request, targetLifeTax: 2 })).not.toBeNull();
  });

  it('a Treasure cannot both produce mana by sacrificing itself and pay a sacrifice cost', () => {
    const { ctx, offered } = setup(
      [{ kind: 'sacrificeOther', selector: ofType('Artifact') }],
      '{G}',
    );
    const treasure = spawn(
      ctx,
      'P1',
      oracle({ name: 'Mana sacrifice probe', typeLine: 'Artifact' }),
    );
    ctx.defs.get(treasure.oracleId)!.manaAbilities = [
      {
        costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }],
        units: [['G']],
      },
    ];
    expect(offered()).toBeUndefined();
  });

  it('a creature may tap for mana and then pay the required sacrifice', () => {
    const { ctx, player, cast } = setup(
      [{ kind: 'sacrificeOther', selector: ofType('Creature') }],
      '{G}',
    );
    const creature = spawn(
      ctx,
      'P1',
      oracle({ name: 'Mana creature probe', oracleText: '{T}: Add {G}.' }),
    );
    cast();
    expect(ctx.state.battlefield).not.toContain(creature);
    expect(player.graveyard.some((card) => card.cardId === creature.cardId)).toBe(true);
    expect(ctx.state.eventLog.filter((event) => event.type === 'tapForMana')).toHaveLength(1);
    expect(ctx.state.stack.at(-1)?.description).toBe('Joint cost probe');
  });

  it('a permanent required for a tap cost cannot also supply mana by tapping', () => {
    const { ctx, offered } = setup([{ kind: 'tapOther', selector: ofType('Creature') }], '{G}');
    spawn(ctx, 'P1', oracle({ name: 'Only mana creature', oracleText: '{T}: Add {G}.' }));
    expect(offered()).toBeUndefined();
    spawn(ctx, 'P1', forest());
    expect(offered()).toBeDefined();
  });

  it('the payment preview reserves the required tap object, matching actual mana payment', () => {
    const { ctx, offered, cast } = setup([{ kind: 'tapOther', selector: ofType('Land') }], '{G}');
    const land = spawn(ctx, 'P1', forest());
    const creature = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Preview mana creature',
        oracleText: '{T}: Add {G}.',
      }),
    );
    expect(offered()?.data?.['paymentSourceIds']).toEqual([creature.id]);
    cast();
    expect(land.tapped).toBe(true);
    expect(creature.tapped).toBe(true);
    const manaEvent = ctx.state.eventLog.find((event) => event.type === 'tapForMana');
    expect(manaEvent?.payload['cardId']).toBe(creature.cardId);
  });

  it.each(['tapOther', 'sacrificeOther'] as const)(
    'one creature cannot pay two %s costs',
    (kind) => {
      const { ctx, offered, cast } = setup([
        { kind, selector: ofType('Creature') },
        { kind, selector: ofType('Creature') },
      ]);
      const first = spawn(ctx, 'P1', bear());
      expect(offered()).toBeUndefined();
      const second = spawn(ctx, 'P1', oracle({ ...bear(), name: 'Second bear' }));
      cast();
      if (kind === 'tapOther') {
        expect(first.tapped).toBe(true);
        expect(second.tapped).toBe(true);
      } else expect(ctx.state.battlefield).toHaveLength(0);
    },
  );

  it('tapping then sacrificing the same creature is legal regardless of the printed cost order', () => {
    const { ctx, player, cast } = setup([
      { kind: 'sacrificeOther', selector: ofType('Creature') },
      { kind: 'tapOther', selector: ofType('Creature') },
    ]);
    const creature = spawn(ctx, 'P1', bear());
    cast();
    expect(player.graveyard.some((card) => card.cardId === creature.cardId)).toBe(true);
    expect(ctx.state.eventLog.findIndex((event) => event.type === 'tap')).toBeLessThan(
      ctx.state.eventLog.findIndex((event) => event.type === 'sacrifice'),
    );
  });

  it('discard and hand exile cannot consume the same card or the proposed spell', () => {
    const { ctx, player, request, offered } = setup([
      { kind: 'discardCard' },
      { kind: 'exileCardFromHand', selector: ofType('Creature') },
    ]);
    conjure(ctx, 'P1', bear(), 'hand');
    expect(offered()).toBeUndefined();
    conjure(ctx, 'P1', forest(), 'hand');
    const option = offered()!;
    expect(option).toBeDefined();
    const result = checkContinuations(ctx, (copy) =>
      applyPriorityAction(copy, copy.state.players[0]!, option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(result.failures).toEqual([]);
    expect(result.completions).toBe(1);
    const witness = planSpellPayment(ctx, player, request)!;
    expect(witness.choices[0]!.objectId).toBe(
      player.hand.find((card) => card.name === 'Forest')!.id,
    );
  });

  it('repeated graveyard exile costs require distinct cards', () => {
    const { ctx, offered, cast, player } = setup([
      { kind: 'exileOtherCardsFromGraveyard', count: 1 },
      { kind: 'exileOtherCardsFromGraveyard', count: 1 },
    ]);
    conjure(ctx, 'P1', bear(), 'graveyard');
    expect(offered()).toBeUndefined();
    conjure(ctx, 'P1', forest(), 'graveyard');
    cast();
    expect(player.graveyard).toHaveLength(0);
    expect(ctx.state.exile).toHaveLength(2);
  });

  it('rejects malformed assignment prefixes and unsupported spell cost forms', () => {
    const { ctx, player, request } = setup([{ kind: 'discardCard' }]);
    const card = conjure(ctx, 'P1', forest(), 'hand');
    const choice = { costIndex: 0, ordinal: 0, kind: 'discardCard' as const, objectId: card.id };
    expect(planSpellPayment(ctx, player, request, [choice, choice])).toBeNull();
    expect(planSpellPayment(ctx, player, request, [{ ...choice, costIndex: 9 }])).toBeNull();
    expect(
      planSpellPayment(ctx, player, { ...request, mana: emptyCost(), costs: [{ kind: 'tap' }] }),
    ).toBeNull();
  });
  it('advertises only complete ordinary target assignments when taxes share one life budget', () => {
    const { ctx, player, spell } = setup([]);
    player.life = 3;
    const first = spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', bear());
    ctx.defs.set(first.oracleId, {
      ...ctx.defs.get(first.oracleId)!,
      ruleStatics: [{ kind: 'targetLifeTax', amount: 3 }],
    });
    ctx.defs.set(spell.oracleId, {
      ...ctx.defs.get(spell.oracleId)!,
      spellAbility: {
        kind: 'spell',
        targets: [
          { kind: 'creature', controller: 'opponent' },
          { kind: 'creature', controller: 'opponent' },
        ],
        effects: [
          { op: 'destroy', target: 0 },
          { op: 'destroy', target: 1 },
        ],
      },
    });
    const offered = computePriorityOptions(ctx, player).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(offered).toHaveLength(2);
    for (const option of offered) {
      expect(option.targets?.[0]?.options).toEqual(option.targets?.[1]?.options);
      const proof = checkContinuations(ctx, function* (branch) {
        const outcome = yield {
          decisionType: 'priority',
          player: 'P1',
          prompt: 'tax contract',
          options: [option],
        };
        yield* applyPriorityAction(
          branch,
          branch.state.players[0]!,
          option.payload as PriorityActionPayload,
          outcome,
        );
      });
      expect(proof.failures).toEqual([]);
      expect(proof.completions).toBe(1);
    }
  });
});
