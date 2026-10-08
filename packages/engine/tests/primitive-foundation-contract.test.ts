import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { enforceCardDefinition } from '../src/cards/authoring-validation';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

function setup(cost = '{0}', amount = 3, typeLine = 'Sorcery') {
  const ctx = createGame(gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]));
  const player = ctx.state.players[0]!;
  ctx.state.currentTurnPlayer = player.id;
  ctx.state.phase = 'precombatMain';
  ctx.state.turnNumber = 3;
  const card = conjure(
    ctx,
    player.id,
    oracle({
      name: 'Independent foundation probe',
      typeLine,
      manaCost: cost,
      oracleText: `You gain ${amount} life.`,
    }),
    'hand',
  );
  const offered = () =>
    computePriorityOptions(ctx, player).find(
      (option) => (option.payload as { objectId?: string }).objectId === card.id,
    );
  const cast = () => {
    const option = offered();
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
  };
  const reject = () => {
    const before = cloneContractContext(ctx);
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
    expect(ctx.debugLog).toEqual(before.debugLog);
    expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  };
  return { ctx, player, card, offered, cast, reject };
}

describe('independent bounded spell foundations', () => {
  it('CardDefinition: positive', () => {
    const state = setup();
    state.cast();
    const entry = state.ctx.state.stack[0]!;
    expect(entry.card?.cardId).toBe(state.card.cardId);
    expect(entry.sourceOracleId).toBe(state.card.oracleId);
    expect(entry.sourceId).toBe(entry.id);
    expect(entry.spellDefinition?.types).toEqual(['Sorcery']);
    expect(state.player.hand.some((card) => card.cardId === state.card.cardId)).toBe(false);
    pump(resolveTopOfStack(state.ctx));
    expect(state.player.graveyard.some((card) => card.cardId === state.card.cardId)).toBe(true);
    expect(state.player.life).toBe(43);
  });
  it('CardDefinition: negative', () => {
    const state = setup();
    state.ctx.defs.set(state.card.oracleId, {
      ...state.ctx.defs.get(state.card.oracleId)!,
      modeled: false,
      unmodeledReasons: ['independent unsupported probe'],
    });
    expect(state.offered).toThrow('Unmodeled');
    state.reject();
  });
  it('CardDefinition.manaCost: positive', () => {
    const state = setup('{G}');
    addMana(state.player, [{ symbol: 'G' }]);
    state.cast();
    expect(state.player.manaEntries).toEqual([]);
    expect(state.player.life).toBe(40);
    expect(state.ctx.state.stack).toHaveLength(1);
    pump(resolveTopOfStack(state.ctx));
    expect(state.player.life).toBe(43);
  });
  it('CardDefinition.manaCost: negative', () => {
    const state = setup('{G}');
    expect(state.offered()).toBeUndefined();
    state.reject();
  });
  it('CardDefinition.spellAbility: positive', () => {
    const state = setup();
    state.cast();
    expect(state.ctx.state.stack[0]?.ability?.kind).toBe('spell');
    expect(state.player.life).toBe(40);
    pump(resolveTopOfStack(state.ctx));
    expect(state.player.life).toBe(43);
    expect(state.ctx.state.stack).toEqual([]);
  });
  it('CardDefinition.spellAbility: negative', () => {
    const state = setup();
    const definition = state.ctx.defs.get(state.card.oracleId)!;
    state.ctx.defs.set(
      state.card.oracleId,
      enforceCardDefinition({
        ...definition,
        spellAbility: { kind: 'activated', targets: [], effects: [] },
      }),
    );
    expect(state.offered).toThrow('Unmodeled');
    state.reject();
  });
  it('Ability.spell: positive', () => {
    for (const typeLine of ['Instant', 'Sorcery']) {
      const state = setup('{0}', 3, typeLine);
      state.cast();
      expect(state.ctx.state.eventLog.filter((event) => event.type === 'castSpell')).toHaveLength(
        1,
      );
      pump(resolveTopOfStack(state.ctx));
      expect(state.player.life).toBe(43);
    }
  });
  it('Ability.spell: negative', () => {
    const state = setup();
    state.ctx.state.currentTurnPlayer = 'P2';
    state.ctx.state.activePlayerIndex = 1;
    expect(state.offered()).toBeUndefined();
    state.reject();
  });
  it('Ability.effects: positive', () => {
    const state = setup();
    state.ctx.defs.set(state.card.oracleId, {
      ...state.ctx.defs.get(state.card.oracleId)!,
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'gainLife', amount: { kind: 'const', n: 2 } },
          { op: 'gainLife', amount: { kind: 'const', n: 3 } },
        ],
      },
    });
    state.cast();
    pump(resolveTopOfStack(state.ctx));
    expect(state.player.life).toBe(45);
    expect(
      state.ctx.state.eventLog
        .filter((event) => event.type === 'lifeGain')
        .map((event) => event.payload['amount']),
    ).toEqual([2, 3]);
  });
  it('Ability.effects: negative', () => {
    const state = setup();
    const before = cloneContractContext(state.ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          state.ctx,
          state.player,
          { kind: 'castSpell', objectId: state.card.id, fromCommand: false },
          { index: 0, targets: new Map([[0, 'P2']]) },
        ),
      ),
    ).toThrow();
    expect(state.ctx.state).toEqual(before.state);
    expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });
  it('ParsedManaCost: positive', () => {
    const state = setup('{1}{G}');
    addMana(state.player, [{ symbol: 'C' }, { symbol: 'G' }, { symbol: 'R' }]);
    state.cast();
    expect(state.player.manaEntries.map((entry) => entry.symbol)).toEqual(['R']);
    pump(resolveTopOfStack(state.ctx));
    expect(state.player.life).toBe(43);
  });
  it('ParsedManaCost: negative', () => {
    const state = setup('{1}{G}');
    addMana(state.player, [{ symbol: 'C' }, { symbol: 'R' }, { symbol: 'R' }]);
    expect(state.offered()).toBeUndefined();
    state.reject();
  });
  it('Effect.gainLife: positive', () => {
    const state = setup();
    state.cast();
    pump(resolveTopOfStack(state.ctx));
    expect(state.player.life).toBe(43);
    expect(state.ctx.state.players[1]!.life).toBe(40);
    expect(state.ctx.state.eventLog.filter((event) => event.type === 'lifeGain')).toHaveLength(1);
  });
  it('Effect.gainLife: negative', () => {
    const state = setup('{0}', 0);
    state.cast();
    pump(resolveTopOfStack(state.ctx));
    expect(state.player.life).toBe(40);
    expect(state.ctx.state.eventLog.some((event) => event.type === 'lifeGain')).toBe(false);
  });
  it('Value.const: positive', () => {
    for (const amount of [0, 1, 5, 1000]) {
      const state = setup('{0}', amount);
      state.player.life = 7;
      state.cast();
      pump(resolveTopOfStack(state.ctx));
      expect(state.player.life).toBe(7 + amount);
    }
  });
  it('Value.const: negative', () => {
    const state = setup();
    const definition = state.ctx.defs.get(state.card.oracleId)!;
    state.ctx.defs.set(
      state.card.oracleId,
      enforceCardDefinition({
        ...definition,
        spellAbility: {
          kind: 'spell',
          targets: [],
          effects: [{ op: 'gainLife', amount: { kind: 'const', n: NaN } }],
        },
      }),
    );
    expect(state.offered).toThrow('Unmodeled');
    state.reject();
  });
});
