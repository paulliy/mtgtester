import { describe, expect, it } from 'vitest';
import type { ManaAbilitySpec, ManaRider } from '../src/cards/ability';
import { enforceCardDefinition, validateCardDefinition } from '../src/cards/authoring-validation';
import { applyManaRider, payManaCost } from '../src/effects/resolve';
import { parseManaCost, planPayment } from '../src/mana/cost';
import { manaSourcesFor } from '../src/state/queries';
import { createGame } from '../src/state/game';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

function setup(riders: unknown) {
  const ctx = createGame(gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]));
  const player = ctx.state.players[0]!;
  const source = spawn(
    ctx,
    player.id,
    oracle({ name: 'Mana rider scope probe', typeLine: 'Artifact' }),
  );
  const definition = {
    ...ctx.defs.get(source.oracleId)!,
    manaAbilities: [
      {
        costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 1 }],
        units: [['G']],
        onActivate: riders,
      } as unknown as ManaAbilitySpec,
    ],
  };
  ctx.defs.set(source.oracleId, definition);
  const cost = parseManaCost('{G}').cost!;
  return { ctx, player, source, definition, cost, pay: () => pump(payManaCost(ctx, player, cost)) };
}

const invalid = [
  { name: 'draw', effect: { op: 'draw', count: { kind: 'const', n: 1 } } },
  { name: 'library shuffle', effect: { op: 'shuffle' } },
  {
    name: 'targeted counters',
    effect: { op: 'putCounters', target: 0, counter: 'nest', count: 1 },
  },
  { name: 'controller-relative value', effect: { op: 'gainLife', amount: { kind: 'lifeTotal' } } },
  {
    name: 'board selector with implicit controller',
    effect: {
      op: 'gainLife',
      amount: {
        kind: 'countPermanents',
        scope: 'you',
        selector: { kind: 'type', value: 'Creature' },
      },
    },
  },
  { name: 'announced X', effect: { op: 'gainLife', amount: { kind: 'xValue' } } },
  {
    name: 'source-relative count',
    effect: {
      op: 'putCounters',
      target: 'source',
      counter: 'nest',
      count: { kind: 'countersOnSelf', counter: 'nest' },
    },
  },
  { name: 'unknown operation', effect: { op: 'inventedManaEffect' } },
  { name: 'unknown field', effect: { op: 'damageController', amount: 1, drawCards: 1 } },
  { name: 'invalid expression', effect: { op: 'gainLife', amount: { kind: 'inventedValue' } } },
  { name: 'negative damage', effect: { op: 'damageController', amount: -1 } },
  {
    name: 'fractional counters',
    effect: { op: 'putCounters', target: 'source', counter: 'nest', count: 0.5 },
  },
];

describe('immediate mana rider scope contracts', () => {
  it.each(invalid)(
    'rejects $name before costs, effects, hidden-zone access, or RNG mutation',
    ({ effect }) => {
      const state = setup([{ op: 'damageController', amount: 1 }, effect]);
      const before = cloneContractContext(state.ctx);
      const issues = validateCardDefinition(state.definition);
      expect(issues.some((issue) => issue.path.includes('onActivate'))).toBe(true);
      expect(enforceCardDefinition(state.definition).modeled).toBe(false);
      expect(() => manaSourcesFor(state.ctx, state.player.id)).toThrow();
      expect(state.pay).toThrow();
      expect(state.ctx.state).toEqual(before.state);
      expect(state.ctx.defs).toEqual(before.defs);
      expect(state.ctx.debugLog).toEqual(before.debugLog);
      expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
    },
  );

  it.each([
    { name: 'damage', rider: { op: 'damageController', amount: 2 }, life: 37, counters: 0 },
    {
      name: 'gain life',
      rider: { op: 'gainLife', amount: { kind: 'plus', of: { kind: 'const', n: 2 }, n: 1 } },
      life: 42,
      counters: 0,
    },
    {
      name: 'source counters',
      rider: { op: 'putCounters', target: 'source', counter: 'nest', count: 2 },
      life: 39,
      counters: 2,
    },
  ])(
    'executes supported $name through actual activation and payment',
    ({ rider, life, counters }) => {
      const state = setup([rider]);
      expect(validateCardDefinition(state.definition)).toEqual([]);
      state.pay();
      expect(state.source.tapped).toBe(true);
      expect(state.player.life).toBe(life);
      expect(state.source.counters['nest'] ?? 0).toBe(counters);
      expect(state.player.manaEntries).toEqual([]);
    },
  );

  it('preflights prepared-plan riders before paying any source activation cost', () => {
    const state = setup([]);
    const sources = manaSourcesFor(state.ctx, state.player.id);
    const plan = planPayment(
      state.cost,
      state.player.manaEntries,
      sources,
      () => true,
      state.player.life,
    )!;
    expect(plan).not.toBeNull();
    plan.tapSources[0]!.onActivate = [
      { op: 'draw', count: { kind: 'const', n: 1 } } as unknown as ManaRider,
    ];
    const before = cloneContractContext(state.ctx);
    expect(() =>
      pump(
        payManaCost(state.ctx, state.player, state.cost, { kind: 'other' }, [], new Set(), plan),
      ),
    ).toThrow();
    expect(state.ctx.state).toEqual(before.state);
    expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });

  it('direct rider application cannot bypass the immediate scope contract', () => {
    const state = setup([]);
    const before = cloneContractContext(state.ctx);
    expect(() =>
      pump(
        applyManaRider(state.ctx, state.source, state.player, {
          op: 'gainLife',
          amount: { kind: 'lifeTotal' },
        }),
      ),
    ).toThrow('unavailable ability scope');
    expect(state.ctx.state).toEqual(before.state);
  });

  it('rejects cyclic rider values before preview or payment recursion', () => {
    const value: Record<string, unknown> = { kind: 'negate' };
    value['of'] = value;
    const state = setup([{ op: 'gainLife', amount: value }]);
    expect(validateCardDefinition(state.definition)[0]?.message).toBe('cyclic IR graph');
    expect(() => manaSourcesFor(state.ctx, state.player.id)).toThrow('cyclic IR graph');
    expect(state.pay).toThrow('cyclic IR graph');
    expect(state.source.tapped).toBe(false);
    expect(state.player.life).toBe(40);
  });
});
