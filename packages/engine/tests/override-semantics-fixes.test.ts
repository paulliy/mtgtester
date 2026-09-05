/**
 * Behavioral fixtures for authored overrides whose encoded effect differed from the printed
 * card, plus the layer-cache input that made a tapped-conditional static return a stale answer.
 *
 * These are deliberately behavior tests, not shape tests. An override can parse, register, be
 * reported `modeled: true`, and still do something the card does not — which is exactly how
 * each of these survived: "the text is claimed as handled" and "the effect is right" are
 * different statements, and only the second one is worth anything to a deck comparison.
 *
 * Every generator is driven through `pump`. Vitest treats a generator function body as a
 * synchronous pass without ever running it, so `it(..., function* () { ... })` reports green no
 * matter what it asserts — see `delayed-triggers.test.ts` for the three tests that hit this.
 */

import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { resolveCondition } from '../src/cards/condition';
import type { Condition } from '../src/cards/condition';
import { ofType } from '../src/cards/selector';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { forest, gameConfig, oracle, pump, spawn } from './fixtures';

const beast = (name: string): ReturnType<typeof oracle> =>
  oracle({ name, typeLine: 'Creature — Beast', manaCost: '{1}{G}', power: '2', toughness: '2' });

function ctxWithSeats(seats: number, seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: [] })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe("Parasitic Impetus drains the enchanted creature's controller", () => {
  it("the host's controller loses 2 and the Aura's controller gains 2", () => {
    const ctx = ctxWithSeats(2, 'parasitic-life');
    const victim = spawn(ctx, 'P2', beast('Goaded Beast'));
    const aura = spawn(
      ctx,
      'P1',
      oracle({
        oracleId: 'ff3de07d-86c3-49e1-9de0-97c85301ff93',
        name: 'Parasitic Impetus',
        typeLine: 'Enchantment — Aura',
        manaCost: '{2}{B}',
        power: null,
        toughness: null,
        oracleText:
          'Enchant creature\nEnchanted creature gets +2/+2 and is goaded.\nWhenever enchanted creature attacks, its controller loses 2 life and you gain 2 life.',
      }),
    );
    aura.attachedTo = victim.id;

    const me = ctx.state.players.find((p) => p.id === 'P1')!;
    const them = ctx.state.players.find((p) => p.id === 'P2')!;
    const myLife = me.life;
    const theirLife = them.life;

    queueTriggersForEvent(ctx, 'attacks', [{ permanent: victim, playerId: victim.controllerId }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const pending = ctx.state.pendingTriggers[0]!;
    pump(
      executeAbility(
        ctx,
        {
          cardId: pending.sourceCardId,
          name: pending.sourceName,
          oracleId: pending.sourceOracleId,
          controllerId: pending.controllerId,
        },
        pending.ability,
        [],
        pending.triggerObjectCardId,
        pending.scope,
      ),
    );

    // The point of the card: the goaded opponent pays, not you. Resolving the loss against the
    // ability's controller made this "+2 then -2" on one player and a no-op overall.
    expect(them.life).toBe(theirLife - 2);
    expect(me.life).toBe(myLife + 2);
  });
});

describe('Land Tax triggers only when an opponent is actually ahead on lands', () => {
  const landTaxCondition: Condition = { kind: 'opponentControlsMore', selector: ofType('Land') };
  const source = { cardId: 'land-tax', controllerId: 'P1' };
  const check = (ctx: GameContext, condition: Condition): boolean =>
    pump(resolveCondition(ctx, condition, source, 'Land Tax')).value;

  it('does not trigger when you are level with every opponent', () => {
    const ctx = ctxWithSeats(4, 'land-tax-level');
    for (const seat of ['P1', 'P2', 'P3', 'P4'] as const) {
      spawn(ctx, seat, forest());
      spawn(ctx, seat, forest());
    }
    expect(check(ctx, landTaxCondition)).toBe(false);
  });

  it('does not trigger when you are ahead of everyone', () => {
    const ctx = ctxWithSeats(4, 'land-tax-ahead');
    for (let i = 0; i < 5; i++) spawn(ctx, 'P1', forest());
    for (const seat of ['P2', 'P3', 'P4'] as const) spawn(ctx, seat, forest());
    expect(check(ctx, landTaxCondition)).toBe(false);
  });

  it('triggers when a single opponent has more lands than you', () => {
    const ctx = ctxWithSeats(4, 'land-tax-behind');
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P2', forest());
    spawn(ctx, 'P2', forest());
    expect(check(ctx, landTaxCondition)).toBe(true);
  });

  it('is not satisfied merely by the opponents having lands BETWEEN them', () => {
    // The regression this replaces: `countPermanents(land, 'opponents', '>=', 1)` pooled three
    // opponents into one number, so Land Tax fired on nearly every upkeep from turn two and
    // tutored three basics a turn in games it should have sat out entirely.
    const ctx = ctxWithSeats(4, 'land-tax-pooled');
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', forest());
    for (const seat of ['P2', 'P3', 'P4'] as const) {
      spawn(ctx, seat, forest());
      spawn(ctx, seat, forest());
    }
    // Six opponent lands in total, but nobody individually beats your three.
    expect(check(ctx, landTaxCondition)).toBe(false);
    // ...and the shape this replaced says "yes" on the very same board, which is the whole bug.
    expect(
      check(ctx, {
        kind: 'countPermanents',
        selector: ofType('Land'),
        scope: 'opponents',
        cmp: '>=',
        n: 1,
      }),
    ).toBe(true);
  });
});

describe('layer cache tracks tapped state', () => {
  it('Iymrith loses ward {4} when it becomes tapped', () => {
    const ctx = ctxWithSeats(2, 'iymrith-ward');
    const iymrith = spawn(
      ctx,
      'P1',
      oracle({
        oracleId: 'd5efba91-8400-41a3-91c6-cb5e81f07976',
        name: 'Iymrith, Desert Doom',
        typeLine: 'Legendary Creature — Dragon',
        manaCost: '{4}{U}{U}',
        power: '5',
        toughness: '5',
        oracleText:
          "Flying\nIymrith, Desert Doom has ward {4} as long as it's untapped.\nWhenever Iymrith, Desert Doom deals combat damage to a player, draw a card. Then if you have fewer than three cards in hand, draw cards equal to the difference.",
      }),
    );

    // Query first so the untapped answer is the one sitting in the cache.
    expect(computeCharacteristics(ctx, iymrith).ward).not.toBeNull();

    iymrith.tapped = true;
    expect(computeCharacteristics(ctx, iymrith).ward).toBeNull();

    iymrith.tapped = false;
    expect(computeCharacteristics(ctx, iymrith).ward).not.toBeNull();
  });
});
