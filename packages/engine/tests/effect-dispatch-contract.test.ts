import { describe, expect, it } from 'vitest';
import type { Ability, Effect } from '../src/cards/ability';
import { executeAbility, payAbilityCosts } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { canPayNonManaCosts } from '../src/state/queries';
import { bear, copies, forest, gameConfig, pump, spawn } from './fixtures';

function setup() {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  const permanent = spawn(ctx, 'P1', bear());
  const source = {
    cardId: 'primitive-source',
    name: 'Primitive source',
    oracleId: forest().oracleId,
    controllerId: 'P1' as const,
  };
  return { ctx, permanent, source };
}

describe('effect executor contracts independent of production cards', () => {
  it.each([1, 5])('removes up to %i counters from a targeted permanent', (count) => {
    const { ctx, permanent, source } = setup();
    permanent.counters['charge'] = 2;
    permanent.counters['other'] = 3;
    const ability: Ability = {
      kind: 'spell',
      targets: [{ kind: 'permanent' }],
      effects: [{ op: 'removeCounters', target: 0, counter: 'charge', count }],
    };
    pump(executeAbility(ctx, source, ability, [permanent.id]));
    expect(permanent.counters['charge']).toBe(count === 1 ? 1 : undefined);
    expect(permanent.counters['other']).toBe(3);
    expect(ctx.state.eventLog.some((event) => event.type === 'removeCounter')).toBe(true);
  });

  it('does not remove counters from an illegal target', () => {
    const { ctx, permanent, source } = setup();
    permanent.counters['charge'] = 2;
    const ability: Ability = {
      kind: 'spell',
      targets: [{ kind: 'player' }],
      effects: [{ op: 'removeCounters', target: 0, counter: 'charge', count: 1 }],
    };
    pump(executeAbility(ctx, source, ability, [permanent.id]));
    expect(permanent.counters['charge']).toBe(2);
  });

  it('fails closed for an unknown runtime effect', () => {
    const { ctx, source } = setup();
    const ability: Ability = {
      kind: 'spell',
      targets: [],
      effects: [{ op: 'unregistered-runtime-effect' } as unknown as Effect],
    };
    expect(() => pump(executeAbility(ctx, source, ability, []))).toThrow('Effect executor');
  });

  it('refuses zone-only costs on the battlefield without charging anything', () => {
    const { ctx, permanent } = setup();
    const costs = [{ kind: 'exileOtherCardsFromGraveyard' as const, count: 0 }];
    expect(canPayNonManaCosts(ctx, permanent, costs)).toBe(false);
    expect(() =>
      pump(payAbilityCosts(ctx, ctx.state.players[0]!, permanent, costs, 'tap')),
    ).toThrow('not a battlefield activation cost');
    expect(ctx.state.battlefield).toContain(permanent);
  });
});
