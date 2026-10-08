import { describe, expect, it } from 'vitest';
import type { AbilityCost } from '../src/cards/ability';
import { payLife, payManaCost } from '../src/effects/resolve';
import { parseManaCost, planPayment } from '../src/mana/cost';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

function setup() {
  const ctx = createGame(gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]));
  const player = ctx.state.players[0]!;
  player.life = -3;
  return { ctx, player };
}

describe('CR 119.4b zero life payment contracts', () => {
  it('can always pay zero life, without a life-loss event or state mutation', () => {
    const { ctx, player } = setup();
    const before = cloneContractContext(ctx);
    payLife(ctx, player, 0);
    expect(ctx.state).toEqual(before.state);
    expect(ctx.debugLog).toEqual(before.debugLog);
    expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1])(
    'rejects an invalid or unaffordable positive life amount %s',
    (amount) => {
      const { ctx, player } = setup();
      expect(() => payLife(ctx, player, amount)).toThrow('life cost became unpayable');
      expect(player.life).toBe(-3);
    },
  );

  it.each([
    { kind: 'payLife', amount: 0 },
    { kind: 'payLifeValue', amount: { kind: 'const', n: 0 } },
  ] as AbilityCost[])('activates a source with a zero life cost below zero: %j', (lifeCost) => {
    const { ctx, player } = setup();
    const source = spawn(
      ctx,
      player.id,
      oracle({ name: 'Zero life mana source', typeLine: 'Artifact' }),
    );
    ctx.defs.set(source.oracleId, {
      ...ctx.defs.get(source.oracleId)!,
      manaAbilities: [{ units: [['G']], costs: [{ kind: 'tap' }, lifeCost] }],
    });
    expect(manaSourcesFor(ctx, player.id)).toHaveLength(1);
    pump(payManaCost(ctx, player, parseManaCost('{G}').cost!));
    expect(source.tapped).toBe(true);
    expect(player.life).toBe(-3);
    expect(player.manaEntries).toEqual([]);
    expect(ctx.state.eventLog.some((event) => event.type === 'lifeLoss')).toBe(false);
  });

  it('can pay a Phyrexian pip with mana while life is negative', () => {
    const { ctx, player } = setup();
    addMana(player, [{ symbol: 'G' }]);
    const cost = parseManaCost('{G/P}').cost!;
    const plan = planPayment(cost, player.manaEntries, [], () => true, player.life);
    expect(plan?.lifePaid).toBe(0);
    pump(payManaCost(ctx, player, cost));
    expect(player.life).toBe(-3);
    expect(player.manaEntries).toEqual([]);
  });

  it('cannot replace a Phyrexian pip with positive life below zero', () => {
    const { player } = setup();
    expect(planPayment(parseManaCost('{G/P}').cost!, [], [], () => true, player.life)).toBeNull();
  });
});
