import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import type { Value } from '../src/cards/value';
import type { Condition } from '../src/cards/condition';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { addMana } from '../src/mana/pool';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const values: { name: string; value: Value; base: number; changed: number }[] = [
  { name: 'implicit trigger power', value: { kind: 'powerOfTriggerObject' }, base: 2, changed: 7 },
  {
    name: 'explicit trigger power',
    value: { kind: 'powerOfTarget', target: 'triggerObject' },
    base: 2,
    changed: 7,
  },
  {
    name: 'implicit trigger counters',
    value: { kind: 'countersOnTriggerObject', counter: 'charge' },
    base: 2,
    changed: 7,
  },
  {
    name: 'explicit trigger counters',
    value: { kind: 'countersOnTarget', target: 'triggerObject', counter: 'charge' },
    base: 2,
    changed: 7,
  },
  {
    name: 'trigger mana value',
    value: { kind: 'manaValueOfTarget', target: 'triggerObject' },
    base: 2,
    changed: 2,
  },
];
const sourceValues: typeof values = [
  {
    name: 'explicit source power',
    value: { kind: 'powerOfTarget', target: 'source' },
    base: 2,
    changed: 7,
  },
  {
    name: 'explicit source counters',
    value: { kind: 'countersOnTarget', target: 'source', counter: 'charge' },
    base: 2,
    changed: 7,
  },
  {
    name: 'explicit source mana value',
    value: { kind: 'manaValueOfTarget', target: 'source' },
    base: 1,
    changed: 1,
  },
  { name: 'source power', value: { kind: 'powerOfSource' }, base: 2, changed: 7 },
  { name: 'source toughness', value: { kind: 'toughnessOfSource' }, base: 2, changed: 7 },
  {
    name: 'source counters',
    value: { kind: 'countersOnSelf', counter: 'charge' },
    base: 2,
    changed: 7,
  },
  { name: 'all source counters', value: { kind: 'allCountersOnSelf' }, base: 2, changed: 7 },
];
describe('implicit event values retain object identity and last known information', () => {
  for (const entry of [...values, ...sourceValues]) {
    it(`${entry.name} uses the live original's current facts`, () => {
      const state = setup(entry.value, sourceValues.includes(entry));
      state.change();
      pump(runPrioritySequence(state.ctx));
      expect(state.player.life).toBe(40 + entry.changed);
    });
    it(`${entry.name} does not borrow the blinked incarnation's facts`, () => {
      const state = setup(entry.value, sourceValues.includes(entry));
      state.cast({ op: 'blinkTarget', target: 0 });
      state.change();
      pump(runPrioritySequence(state.ctx));
      expect(state.player.life).toBe(40 + entry.base);
    });
    it(`${entry.name} refreshes last known facts immediately before the original leaves`, () => {
      const state = setup(entry.value, sourceValues.includes(entry));
      state.change();
      state.cast({ op: 'blinkTarget', target: 0 });
      pump(runPrioritySequence(state.ctx));
      expect(state.player.life).toBe(40 + entry.changed);
    });
    it(`${entry.name} retains facts after a normal destruction spell`, () => {
      const state = setup(entry.value, sourceValues.includes(entry));
      state.cast({ op: 'destroy', target: 0 });
      pump(runPrioritySequence(state.ctx));
      expect(state.player.life).toBe(40 + entry.base);
    });
  }
});

describe('event predicates retain the same object scope as numeric values', () => {
  const condition: Condition = {
    kind: 'triggerObjectMatches',
    selector: { kind: 'powerAtLeast', n: 5 },
  };
  it('reads current characteristics of the live original', () => {
    const state = setup({ kind: 'const', n: 0 }, false, condition);
    state.change();
    pump(runPrioritySequence(state.ctx));
    expect(state.player.life).toBe(47);
  });
  it('does not borrow the returning incarnation characteristics', () => {
    const state = setup({ kind: 'const', n: 0 }, false, condition);
    state.cast({ op: 'blinkTarget', target: 0 });
    state.change();
    pump(runPrioritySequence(state.ctx));
    expect(state.player.life).toBe(42);
  });
  it('retains changed departure characteristics', () => {
    const state = setup({ kind: 'const', n: 0 }, false, condition);
    state.change();
    state.cast({ op: 'blinkTarget', target: 0 });
    pump(runPrioritySequence(state.ctx));
    expect(state.player.life).toBe(47);
  });
  it('retains original departure characteristics after destruction', () => {
    const state = setup({ kind: 'const', n: 0 }, false, condition);
    state.cast({ op: 'destroy', target: 0 });
    pump(runPrioritySequence(state.ctx));
    expect(state.player.life).toBe(42);
  });
});

describe('activation costs preserve source departure facts', () => {
  for (const entry of sourceValues) {
    it(`${entry.name} survives sacrificing the source as an activation cost`, () => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      ctx.state.currentTurnPlayer = 'P1';
      ctx.state.activePlayerIndex = 0;
      ctx.state.phase = 'precombatMain';
      const player = ctx.state.players[0]!;
      const source = spawn(ctx, 'P1', oracle({ name: 'Independent sacrificed value source' }));
      source.counters = { charge: 2 };
      const definition = {
        ...ctx.defs.get(source.oracleId)!,
        activatedAbilities: [
          {
            costs: [{ kind: 'sacrificeSelf' as const }],
            timing: 'any' as const,
            ability: {
              kind: 'activated' as const,
              targets: [],
              effects: [{ op: 'gainLife' as const, amount: entry.value }],
            },
          },
        ],
      };
      expect(validateCardDefinition(definition)).toEqual([]);
      ctx.defs.set(source.oracleId, definition);
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'activateAbility', objectId: source.id, index: 0 },
          { index: 0, targets: new Map() },
        ),
      );
      expect(player.graveyard.some((card) => card.cardId === source.cardId)).toBe(true);
      pump(runPrioritySequence(ctx));
      expect(player.life).toBe(40 + entry.base);
    });
  }
});

describe('a resolving spell retains its announced source mana value', () => {
  it.each([
    { cost: '{0}', x: undefined, expected: 0 },
    { cost: '{1}{G}', x: undefined, expected: 2 },
    { cost: '{X}{G}', x: 2, expected: 3 },
  ])('$cost with X=$x reads mana value $expected', ({ cost, x, expected }) => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'precombatMain';
    const player = ctx.state.players[0]!;
    const card = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Independent spell source value',
        typeLine: 'Sorcery',
        manaCost: cost,
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    const definition = {
      ...ctx.defs.get(card.oracleId)!,
      spellAbility: {
        kind: 'spell' as const,
        targets: [],
        effects: [
          {
            op: 'gainLife' as const,
            amount: { kind: 'manaValueOfTarget' as const, target: 'source' as const },
          },
        ],
      },
    };
    expect(validateCardDefinition(definition)).toEqual([]);
    ctx.defs.set(card.oracleId, definition);
    addMana(player, [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }]);
    pump(
      applyPriorityAction(
        ctx,
        player,
        {
          kind: 'castSpell',
          objectId: card.id,
          fromCommand: false,
          ...(x === undefined ? {} : { x }),
        },
        { index: 0, targets: new Map() },
      ),
    );
    pump(runPrioritySequence(ctx));
    expect(player.life).toBe(40 + expected);
  });
});

function setup(value: Value, sourceReference = false, condition?: Condition) {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const watcher = spawn(
    ctx,
    'P1',
    sourceReference
      ? oracle({ name: 'Independent numeric source watcher', typeLine: 'Creature — Witness' })
      : oracle({ name: 'Independent numeric event watcher', typeLine: 'Enchantment' }),
  );
  if (sourceReference) watcher.counters = { charge: 2 };
  const base = ctx.defs.get(watcher.oracleId)!;
  const definition = {
    ...base,
    triggers: [
      {
        kind: 'triggered' as const,
        trigger: {
          when: 'enters' as const,
          subject: {
            kind: 'permanent' as const,
            selector: { kind: 'type' as const, value: 'Creature' },
          },
        },
        targets: [],
        effects:
          condition === undefined
            ? [{ op: 'gainLife' as const, amount: value }]
            : [
                {
                  op: 'conditionalEffect' as const,
                  condition,
                  then: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 7 } }],
                  else: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 2 } }],
                },
              ],
      },
    ],
  };
  expect(validateCardDefinition(definition)).toEqual([]);
  ctx.defs.set(watcher.oracleId, definition);
  const card = conjure(ctx, 'P2', bear(), 'hand');
  const creatureDef = {
    ...ctx.defs.get(card.oracleId)!,
    entersWithCounters: { charge: { kind: 'const' as const, n: 2 } },
  };
  expect(validateCardDefinition(creatureDef)).toEqual([]);
  ctx.defs.set(card.oracleId, creatureDef);
  addMana(ctx.state.players[1]!, [{ symbol: 'C' }, { symbol: 'G' }]);
  ctx.state.currentTurnPlayer = 'P2';
  ctx.state.activePlayerIndex = 1;
  pump(
    applyPriorityAction(
      ctx,
      ctx.state.players[1]!,
      { kind: 'castSpell', objectId: card.id, fromCommand: false },
      { index: 0, targets: new Map() },
    ),
  );
  pump(resolveTopOfStack(ctx));
  expect(ctx.state.pendingTriggers).toHaveLength(1);
  ctx.defs.set(watcher.oracleId, base);
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  const referencedCardId = sourceReference ? watcher.cardId : card.cardId;
  const current = () => ctx.state.battlefield.find((object) => object.cardId === referencedCardId)!;
  function cast(effect: Effect) {
    const spell = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Independent numeric response',
        typeLine: 'Instant',
        manaCost: '{0}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    const definition = {
      ...ctx.defs.get(spell.oracleId)!,
      spellAbility: {
        kind: 'spell' as const,
        targets: [{ kind: 'creature' as const }],
        effects: [effect],
      },
    };
    expect(validateCardDefinition(definition)).toEqual([]);
    ctx.defs.set(spell.oracleId, definition);
    pump(
      applyPriorityAction(
        ctx,
        player,
        { kind: 'castSpell', objectId: spell.id, fromCommand: false },
        { index: 0, targets: new Map([[0, current().id]]) },
      ),
    );
    pump(resolveTopOfStack(ctx));
  }
  function change() {
    cast({ op: 'pumpUntilEot', target: 0, power: 5, toughness: 5 });
    cast({ op: 'putCounters', target: 0, counter: 'charge', count: { kind: 'const', n: 5 } });
  }
  return { ctx, player, cast, change };
}
