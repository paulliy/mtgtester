import { forcedOutcome, isForced } from '../src/decisions';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { AbilityCost, CardDefinition } from '../src/cards/definition';
import { ofType } from '../src/cards/selector';
import { createGame } from '../src/state/game';
import { wardCostOf } from '../src/state/queries';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

function setup(costs: AbilityCost[] = [], changes: Partial<CardDefinition> = {}, manaCost = '{0}') {
  const ctx = createGame(
    gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }], {
      seed: 'casting-proposal',
    }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const spell = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Casting phase probe',
      typeLine: 'Sorcery',
      manaCost,
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  ctx.defs.set(spell.oracleId, {
    ...ctx.defs.get(spell.oracleId)!,
    spellAdditionalCosts: costs,
    ...changes,
  });
  const payload: PriorityActionPayload = {
    kind: 'castSpell',
    objectId: spell.id,
    fromCommand: false,
  };
  const cast = (targets = new Map()) =>
    applyPriorityAction(ctx, player, payload, { index: 0, targets });
  return { ctx, player, spell, payload, cast };
}

const counted = {
  spellAbility: {
    kind: 'spell' as const,
    targets: [{ kind: 'creature' as const, count: { min: 0, max: 1 } }],
    effects: [{ op: 'putCountersEachChosen' as const, targetSlot: 0, counter: '+1/+1', count: 1 }],
  },
};

describe('casting phase and recovery contracts', () => {
  it('the proposal leaves hand and is on the stack before the first target choice', () => {
    const { ctx, player, spell, cast } = setup([], counted);
    spawn(ctx, 'P2', bear());
    const originalHand = player.hand;
    const before = cloneContractContext(ctx);
    const generator = cast();
    expect(generator.next().done).toBe(false);
    expect(player.hand).toHaveLength(0);
    expect(ctx.state.stack[0]?.card?.cardId).toBe(spell.cardId);
    expect(ctx.state.stack[0]?.castInProgress).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'castSpell')).toBe(false);
    // A suspended proposal may have advanced randomness or emitted speculative logs.
    ctx.rng.nextUint32();
    generator.return(undefined);
    expect(player.hand).toBe(originalHand);
    expect(player.hand[0]).toBe(spell);
    expect(ctx.state.players[0]).toBe(player);
    expect(ctx.state).toEqual(before.state);
    expect(ctx.debugLog).toEqual(before.debugLog);
    expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });

  it('a malformed target continuation restores the source object and all proposal records', () => {
    const { ctx, cast } = setup([], counted);
    spawn(ctx, 'P2', bear());
    const before = cloneContractContext(ctx);
    const generator = cast();
    generator.next();
    expect(() => generator.next({ index: 999, targets: new Map() })).toThrow();
    expect(ctx.state).toEqual(before.state);
    expect(ctx.debugLog).toEqual(before.debugLog);
  });

  it('joint preview reads the hand after the proposed spell has departed', () => {
    const { ctx, player, spell, cast } = setup([
      {
        kind: 'payLifeValue',
        amount: {
          kind: 'countCardsInZone',
          zone: 'hand',
          owner: 'you',
          selector: { kind: 'not', of: { kind: 'isToken' } },
        },
      },
    ]);
    conjure(ctx, 'P1', bear(), 'hand');
    player.life = 1;
    const before = cloneContractContext(ctx);
    expect(
      computePriorityOptions(ctx, player).some(
        (option) =>
          (option.payload as PriorityActionPayload).kind === 'castSpell' &&
          (option.payload as { objectId?: string }).objectId === spell.id,
      ),
    ).toBe(true);
    expect(ctx.state).toEqual(before.state);
    pump(cast());
    expect(player.life).toBe(0);
    expect(player.hand).toHaveLength(1);
  });

  it('records ward before a granting source is sacrificed as an additional cost', () => {
    const { ctx, player, cast } = setup(
      [{ kind: 'sacrificeOther', selector: ofType('Enchantment') }],
      {
        spellAbility: {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'putCounters', target: 0, counter: '+1/+1', count: 1 }],
        },
      },
    );
    const grant = spawn(
      ctx,
      'P1',
      oracle({ name: 'Ward grant probe', typeLine: 'Enchantment', manaCost: '{0}' }),
    );
    ctx.defs.set(grant.oracleId, {
      ...ctx.defs.get(grant.oracleId)!,
      staticEffects: [
        { affects: ofType('Creature'), op: { layer: 6, addWard: { kind: 'life', amount: 9 } } },
      ],
    });
    const target = spawn(ctx, 'P2', bear());
    expect(wardCostOf(ctx, target)).not.toBeNull();
    pump(cast(new Map([[0, target.id]])));
    expect(player.graveyard.some((card) => card.cardId === grant.cardId)).toBe(true);
    expect(wardCostOf(ctx, target)).toBeNull();
    expect(
      ctx.state.pendingTriggers.filter((trigger) =>
        trigger.ability.description?.startsWith('ward'),
      ),
    ).toHaveLength(1);
    expect(ctx.state.stack[0]?.castInProgress).toBeUndefined();
    expect(ctx.state.eventLog.filter((event) => event.type === 'castSpell')).toHaveLength(1);
  });

  it('permission stays locked when its source is sacrificed during payment', () => {
    const { ctx, player, spell, payload } = setup([
      { kind: 'sacrificeOther', selector: ofType('Enchantment') },
    ]);
    player.hand.splice(0, 1);
    spell.zone = 'graveyard';
    player.graveyard.push(spell);
    const grant = spawn(
      ctx,
      'P1',
      oracle({ name: 'Graveyard permission probe', typeLine: 'Enchantment', manaCost: '{0}' }),
    );
    ctx.defs.set(grant.oracleId, {
      ...ctx.defs.get(grant.oracleId)!,
      ruleStatics: [{ kind: 'playFromZone', zone: 'graveyard' }],
    });
    const option = computePriorityOptions(ctx, player).find(
      (option) => option.type === 'castSpell',
    )!;
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(
        ctx,
        player,
        { ...payload, fromGraveyard: true },
        { index: 0, targets: new Map() },
      ),
    );
    expect(ctx.state.stack[0]?.card?.cardId).toBe(spell.cardId);
    expect(player.graveyard.some((card) => card.cardId === grant.cardId)).toBe(true);
  });

  it('a graveyard spell cannot target the card that has already left that graveyard', () => {
    const { ctx, player, spell } = setup([], {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'cardInGraveyard', graveyardOwnerScope: 'controller' }],
        effects: [{ op: 'graveyardToHand', target: 0 }],
      },
    });
    player.hand.splice(0, 1);
    spell.zone = 'graveyard';
    player.graveyard.push(spell);
    const grant = spawn(
      ctx,
      'P1',
      oracle({ name: 'Target departure permission', typeLine: 'Enchantment', manaCost: '{0}' }),
    );
    ctx.defs.set(grant.oracleId, {
      ...ctx.defs.get(grant.oracleId)!,
      ruleStatics: [{ kind: 'playFromZone', zone: 'graveyard' }],
    });
    expect(
      computePriorityOptions(ctx, player).filter((option) => option.type === 'castSpell'),
    ).toEqual([]);
    const other = conjure(ctx, 'P1', bear(), 'graveyard');
    const option = computePriorityOptions(ctx, player).find(
      (option) => option.type === 'castSpell',
    )!;
    expect(option.targets?.[0]?.options).toEqual([other.id]);
  });

  it('interruption during a mana activation choice recovers already paid costs in place', () => {
    const { ctx, player, cast } = setup([], {}, '{1}');
    const source = spawn(
      ctx,
      'P1',
      oracle({ name: 'Resource payment probe', typeLine: 'Enchantment', manaCost: '{0}' }),
    );
    ctx.defs.set(source.oracleId, {
      ...ctx.defs.get(source.oracleId)!,
      manaAbilities: [
        {
          costs: [
            { kind: 'payLife', amount: 2 },
            { kind: 'sacrificeOther', selector: ofType('Creature') },
          ],
          units: [['G']],
        },
      ],
    });
    const first = spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    const before = cloneContractContext(ctx);
    const generator = cast();
    let decision = generator.next();
    while (!decision.done && isForced(decision.value))
      decision = generator.next(forcedOutcome(decision.value));
    expect(decision.done).toBe(false);
    expect(player.life).toBe(before.state.players[0]!.life - 2);
    expect(() => generator.throw(new Error('interrupted proposal'))).toThrow(
      'interrupted proposal',
    );
    expect(ctx.state).toEqual(before.state);
    expect(ctx.state.battlefield.includes(first)).toBe(true);
    expect(ctx.debugLog).toEqual(before.debugLog);
  });

  it('rejects sorcery timing before publishing any proposal', () => {
    const { ctx, cast } = setup();
    ctx.state.phase = 'combat';
    const before = cloneContractContext(ctx);
    expect(() => pump(cast())).toThrow('timing');
    expect(ctx.state).toEqual(before.state);
  });
});
