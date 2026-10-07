import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { AbilityCost, ManaAbilitySpec } from '../src/cards/ability';
import { createGame } from '../src/state/game';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

function setup(manaCost: string, costs: AbilityCost[] = [], targeted = false) {
  const ctx = createGame(gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]));
  const player = ctx.state.players[0]!;
  ctx.state.currentTurnPlayer = player.id;
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  const card = conjure(
    ctx,
    player.id,
    oracle({
      name: 'Stateful casting probe',
      typeLine: 'Sorcery',
      manaCost,
      oracleText: targeted ? 'Target creature gets +1/+1 until end of turn.' : 'You gain 1 life.',
    }),
    'hand',
  );
  ctx.defs.set(card.oracleId, { ...ctx.defs.get(card.oracleId)!, spellAdditionalCosts: costs });
  const source = (name: string, ability: ManaAbilitySpec) => {
    const permanent = spawn(ctx, player.id, oracle({ name, typeLine: 'Artifact' }));
    ctx.defs.set(permanent.oracleId, {
      ...ctx.defs.get(permanent.oracleId)!,
      manaAbilities: [ability],
    });
    return permanent;
  };
  const offered = () =>
    computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === card.id;
    });
  const cast = (targets = new Map<number, string>()) => {
    const option = offered();
    expect(option).toBeDefined();
    return pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets,
      }),
    );
  };
  return { ctx, player, card, source, offered, cast };
}

describe('actual changing-resource spell payment contracts', () => {
  it('rejects a payment made unaffordable by mana damage, without touching state or RNG', () => {
    const state = setup('{G}', [{ kind: 'payLife', amount: 3 }]);
    state.player.life = 3;
    state.source('Damage payment source', {
      units: [['G']],
      onActivate: [{ op: 'damageController', amount: 1 }],
    });
    const before = cloneContractContext(state.ctx);
    expect(state.offered()).toBeUndefined();
    expect(() =>
      pump(
        applyPriorityAction(
          state.ctx,
          state.player,
          { kind: 'castSpell', objectId: state.card.id, fromCommand: false },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow();
    expect(state.ctx.state).toEqual(before.state);
    expect(state.ctx.debugLog).toEqual(before.debugLog);
    expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });

  it('uses mana life gain before paying additional spell life', () => {
    const state = setup('{G}', [{ kind: 'payLife', amount: 3 }]);
    state.player.life = 1;
    const source = state.source('Life payment source', {
      units: [['G']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
    });
    const before = cloneContractContext(state.ctx);
    expect(state.offered()).toBeDefined();
    expect(state.ctx.state).toEqual(before.state);
    state.cast();
    expect(source.tapped).toBe(true);
    expect(state.player.life).toBe(1);
    expect(state.ctx.state.stack).toHaveLength(1);
    expect(
      state.ctx.state.eventLog
        .filter((e) => ['lifeGain', 'lifeLoss'].includes(e.type))
        .map((e) => e.type),
    ).toEqual(['lifeGain', 'lifeLoss']);
  });

  it('finishes mana activations before paying a target life tax', () => {
    const state = setup('{G}', [], true);
    state.player.life = 1;
    state.source('Target-tax life source', {
      units: [['G']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
    });
    const target = spawn(state.ctx, 'P2', bear());
    state.ctx.defs.set(target.oracleId, {
      ...state.ctx.defs.get(target.oracleId)!,
      ruleStatics: [{ kind: 'targetLifeTax', amount: 3 }],
    });
    expect(state.offered()?.targets?.[0]?.options).toContain(target.id);
    state.cast(new Map([[0, target.id]]));
    expect(state.player.life).toBe(1);
    expect(
      state.ctx.state.eventLog
        .filter((e) => ['lifeGain', 'lifeLoss'].includes(e.type))
        .map((e) => e.type),
    ).toEqual(['lifeGain', 'lifeLoss']);
  });

  it('discovers a later activation that becomes affordable after earlier life gain', () => {
    const state = setup('{G}{R}', [{ kind: 'payLife', amount: 1 }]);
    state.player.life = 1;
    const later = state.source('Initially unaffordable source', {
      units: [['R']],
      costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 2 }],
    });
    const earlier = state.source('Unlocking life source', {
      units: [['G']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
    });
    state.cast();
    expect(earlier.tapped).toBe(true);
    expect(later.tapped).toBe(true);
    expect(state.player.life).toBe(1);
    expect(
      state.ctx.state.eventLog
        .filter((e) => ['lifeGain', 'lifeLoss'].includes(e.type))
        .map((e) => e.type),
    ).toEqual(['lifeGain', 'lifeLoss', 'lifeLoss']);
  });

  it('tries another source when the first arithmetic plan would leave unpaid spell life', () => {
    const state = setup('{G}{R}', [{ kind: 'payLife', amount: 1 }]);
    state.player.life = 4;
    const bad = state.source('Bad damage source', {
      units: [['G']],
      onActivate: [{ op: 'damageController', amount: 2 }],
    });
    const costly = state.source('Required life source', {
      units: [['R']],
      costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 2 }],
    });
    const good = state.source('Good ordinary source', { units: [['G']] });
    state.cast();
    expect(bad.tapped).toBe(false);
    expect(costly.tapped).toBe(true);
    expect(good.tapped).toBe(true);
    expect(state.player.life).toBe(1);
  });

  it('can pay Phyrexian life made available by producing the generic mana', () => {
    const state = setup('{1}{G/P}');
    state.player.life = 0;
    state.source('Phyrexian life source', {
      units: [['C']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 2 } }],
    });
    state.cast();
    expect(state.player.life).toBe(0);
    expect(state.player.manaEntries).toEqual([]);
    expect(state.ctx.state.stack).toHaveLength(1);
  });

  it('recomputes a repeated source resource after its counter rider resolves', () => {
    const state = setup('{G}{G}');
    const source = state.source('Restoring-counter source', {
      units: [['G']],
      costs: [{ kind: 'removeCounters', counter: 'nest', count: 1 }],
      onActivate: [{ op: 'putCounters', target: 'source', counter: 'nest', count: 1 }],
    });
    source.counters['nest'] = 1;
    state.cast();
    expect(source.counters['nest']).toBe(1);
    expect(source.tapped).toBe(false);
    expect(state.player.manaEntries).toEqual([]);
    expect(state.ctx.state.eventLog.filter((e) => e.type === 'tapForMana')).toHaveLength(0);
  });

  it.each(['infect', 'lifelink'] as const)(
    'replays actual %s damage instead of treating damage as a life cost',
    (keyword) => {
      const state = setup('{G}', [{ kind: 'payLife', amount: 3 }]);
      state.player.life = 3;
      const source = state.source('Damage trait source', {
        units: [['G']],
        onActivate: [{ op: 'damageController', amount: 2 }],
      });
      state.ctx.defs.set(source.oracleId, {
        ...state.ctx.defs.get(source.oracleId)!,
        keywords: [keyword],
      });
      state.cast();
      expect(state.player.life).toBe(0);
      expect(state.player.poisonCounters).toBe(keyword === 'infect' ? 2 : 0);
    },
  );

  it('finds an activation order that pays life first and may finish below zero before SBAs', () => {
    const state = setup('{G}{R}');
    state.player.life = 4;
    state.source('Deferred damage source', {
      units: [['G']],
      onActivate: [{ op: 'damageController', amount: 3 }],
    });
    state.source('Prior life payment source', {
      units: [['R']],
      costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 4 }],
    });
    state.cast();
    expect(state.player.life).toBe(-3);
    expect(state.ctx.state.stack).toHaveLength(1);
    expect(state.player.hasLost).toBe(false);
  });

  it('does not invent a witness for state-dependent production outside the tested scope', () => {
    const state = setup('{G}', [{ kind: 'payLife', amount: 3 }]);
    state.player.life = 1;
    state.source('Dynamic life source', {
      units: [['G']],
      amount: { kind: 'const', n: 1 },
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
    });
    expect(state.offered).toThrow('outside the proven scope');
    expect(state.player.life).toBe(1);
  });

  it('fails visibly when an unbounded activation loop exceeds the supported witness budget', () => {
    const state = setup('{40}{G}');
    state.player.life = 1;
    state.source('Unbounded life loop source', {
      units: [['G']],
      costs: [{ kind: 'payLife', amount: 1 }],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
    });
    expect(state.offered).toThrow('depth budget exceeded');
    expect(state.player.life).toBe(1);
    expect(state.player.manaEntries).toEqual([]);
  });
});
