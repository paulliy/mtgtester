import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { evaluateValueIn } from '../src/effects/values';
import { cloneContractContext } from './helpers/contract-harness';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function setup(counter: string, mode: 'remove' | 'removeEach' | 'put', present: boolean) {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const target = spawn(ctx, 'P2', bear());
  if (present) target.counters = JSON.parse(JSON.stringify({ [counter]: 2 }));
  const card = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Independent counter-name probe',
      typeLine: 'Instant',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  const effect =
    mode === 'remove'
      ? { op: 'removeCounters' as const, target: 0, counter, count: 1 }
      : mode === 'removeEach'
        ? {
            op: 'removeCountersEach' as const,
            selector: { kind: 'type' as const, value: 'Creature' },
            counter,
            count: 1,
          }
        : {
            op: 'putCounters' as const,
            target: 0,
            counter,
            count: { kind: 'const' as const, n: 1 },
          };
  ctx.defs.set(card.oracleId, {
    ...ctx.defs.get(card.oracleId)!,
    spellAbility: {
      kind: 'spell',
      targets: mode === 'removeEach' ? [] : [{ kind: 'permanent' }],
      effects: [effect],
    },
  });
  const cast = computePriorityOptions(ctx, player).find(
    (option) => (option.payload as { objectId?: string }).objectId === card.id,
  )!;
  pump(
    applyPriorityAction(ctx, player, cast.payload as PriorityActionPayload, {
      index: 0,
      targets: mode === 'removeEach' ? new Map() : new Map([[0, target.id]]),
    }),
  );
  pump(resolveTopOfStack(ctx));
  return { ctx, target };
}

describe('ordinary counter names use owned data through normal casting', () => {
  it.each(['__proto__', 'constructor', 'toString'])(
    'does not remove an inherited %s counter through a normal cast',
    (counter) => {
      const { ctx, target } = setup(counter, 'remove', false);
      expect(Object.keys(target.counters)).toEqual([]);
      expect(ctx.state.eventLog.some((event) => event.type === 'removeCounter')).toBe(false);
      expect(Object.getPrototypeOf(target.counters)).toBe(Object.prototype);
    },
  );
  it.each(['__proto__', 'constructor', 'toString'])(
    'does not remove an inherited %s counter through a collective effect',
    (counter) => {
      const { ctx, target } = setup(counter, 'removeEach', false);
      expect(Object.keys(target.counters)).toEqual([]);
      expect(ctx.state.eventLog.some((event) => event.type === 'removeCounter')).toBe(false);
    },
  );
  it.each(['__proto__', 'constructor', 'toString'])(
    'removes exactly one owned %s counter',
    (counter) => {
      const { target } = setup(counter, 'remove', true);
      expect(target.counters[counter]).toBe(1);
      expect(Object.hasOwn(target.counters, counter)).toBe(true);
      expect(Object.getPrototypeOf(target.counters)).toBe(Object.prototype);
    },
  );
  it.each(['__proto__', 'constructor', 'toString'])(
    'creates an owned numeric %s counter without changing the prototype',
    (counter) => {
      const { target } = setup(counter, 'put', false);
      expect(Object.hasOwn(target.counters, counter)).toBe(true);
      expect(target.counters[counter]).toBe(1);
      expect(Object.getPrototypeOf(target.counters)).toBe(Object.prototype);
    },
  );
});

describe('counter-name payment and remembered-value boundaries', () => {
  it.each(['__proto__', 'constructor', 'toString'])(
    'cannot fund a normal cast with an inherited %s counter cost',
    (counter) => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      ctx.state.currentTurnPlayer = 'P1';
      ctx.state.activePlayerIndex = 0;
      ctx.state.phase = 'precombatMain';
      const player = ctx.state.players[0]!;
      const card = conjure(
        ctx,
        'P1',
        oracle({
          name: 'Counter cost probe',
          typeLine: 'Sorcery',
          manaCost: '{G}',
          oracleText: 'You gain 1 life.',
        }),
        'hand',
      );
      const source = spawn(
        ctx,
        'P1',
        oracle({ name: 'Counter cost source', typeLine: 'Artifact' }),
      );
      ctx.defs.set(source.oracleId, {
        ...ctx.defs.get(source.oracleId)!,
        manaAbilities: [{ costs: [{ kind: 'removeCounters', counter, count: 1 }], units: [['G']] }],
      });
      const before = cloneContractContext(ctx);
      expect(
        computePriorityOptions(ctx, player).some(
          (option) => (option.payload as { objectId?: string }).objectId === card.id,
        ),
      ).toBe(false);
      expect(() =>
        pump(
          applyPriorityAction(
            ctx,
            player,
            { kind: 'castSpell', objectId: card.id, fromCommand: false },
            { index: 0, targets: new Map() },
          ),
        ),
      ).toThrow();
      expect(ctx.state).toEqual(before.state);
      expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
    },
  );
  it.each(['__proto__', 'constructor', 'toString'])(
    'reads owned rather than inherited %s remembered counters',
    (counter) => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      const card = conjure(ctx, 'P1', bear(), 'graveyard');
      card.rememberedCounters = {};
      const scope = { controllerId: 'P1' as const, triggerObjectCardId: card.cardId };
      const value = { kind: 'countersOnTriggerObject' as const, counter };
      expect(evaluateValueIn(ctx, value, scope)).toBe(0);
      card.rememberedCounters = { [counter]: 2 };
      expect(evaluateValueIn(ctx, value, scope)).toBe(2);
      expect(Object.getPrototypeOf(card.rememberedCounters)).toBe(Object.prototype);
    },
  );
});
