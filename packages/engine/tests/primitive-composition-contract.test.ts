import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

const costs = ['{0}', '{1}', '{G}', '{1}{G}'] as const;
const amounts = [0, 1, 7, 1000] as const;
const resources = ['none', 'pool', 'lands'] as const;
const cases = [0, 1, 2].flatMap((seed) =>
  ['Instant', 'Sorcery'].flatMap((typeLine) =>
    costs.flatMap((cost) =>
      amounts.flatMap((amount) =>
        [1, 2].flatMap((instructions) =>
          resources.map((resource) => ({ seed, typeLine, cost, amount, instructions, resource })),
        ),
      ),
    ),
  ),
);

function setup(entry: (typeof cases)[number]) {
  const ctx = createGame(
    gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }], {
      seed: `primitive-composition-${entry.seed}`,
    }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.turnNumber = 3;
  const player = ctx.state.players[0]!;
  const card = conjure(
    ctx,
    player.id,
    oracle({
      name: 'Independent bounded composition',
      typeLine: entry.typeLine,
      manaCost: entry.cost,
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  const definition = {
    ...ctx.defs.get(card.oracleId)!,
    spellAbility: {
      kind: 'spell' as const,
      targets: [],
      effects: Array.from({ length: entry.instructions }, () => ({
        op: 'gainLife' as const,
        amount: { kind: 'const' as const, n: entry.amount },
      })),
    },
  };
  expect(validateCardDefinition(definition), JSON.stringify(entry)).toEqual([]);
  ctx.defs.set(card.oracleId, definition);
  if (entry.resource === 'pool') addMana(player, [{ symbol: 'G' }, { symbol: 'G' }]);
  if (entry.resource === 'lands') {
    spawn(ctx, player.id, forest());
    spawn(ctx, player.id, forest());
  }
  return { ctx, player, card };
}

describe('bounded registered primitive compositions', () => {
  it('every funded composition offers a complete deterministic normal cast', () => {
    expect(cases).toHaveLength(576);
    let verified = 0;
    for (const entry of cases) {
      if (entry.resource === 'none' && entry.cost !== '{0}') continue;
      const { ctx, player, card } = setup(entry);
      const before = cloneContractContext(ctx);
      const options = computePriorityOptions(ctx, player).filter((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === card.id;
      });
      expect(options, JSON.stringify(entry)).toHaveLength(1);
      expect(ctx.state, JSON.stringify(entry)).toEqual(before.state);
      expect(ctx.debugLog).toEqual(before.debugLog);
      const results = [0, 1].map(() => {
        const replay = cloneContractContext(ctx);
        const payer = replay.state.players[0]!;
        pump(
          applyPriorityAction(replay, payer, options[0]!.payload as PriorityActionPayload, {
            index: 0,
            targets: new Map(),
          }),
        );
        expect(payer.life, JSON.stringify(entry)).toBe(40);
        expect(replay.state.stack, JSON.stringify(entry)).toHaveLength(1);
        expect(replay.state.stack[0]!.spellDefinition!.types).toEqual([entry.typeLine]);
        pump(runPrioritySequence(replay));
        expect(payer.life, JSON.stringify(entry)).toBe(40 + entry.amount * entry.instructions);
        expect(payer.graveyard.some((object) => object.cardId === card.cardId)).toBe(true);
        expect(payer.hand.some((object) => object.cardId === card.cardId)).toBe(false);
        expect(replay.state.stack).toEqual([]);
        expect(replay.state.pendingTriggers).toEqual([]);
        expect(replay.state.eventLog.filter((event) => event.type === 'castSpell')).toHaveLength(1);
        return { state: replay.state, debug: replay.debugLog, rng: replay.rng.nextUint32() };
      });
      expect(results[0], JSON.stringify(entry)).toEqual(results[1]);
      expect(ctx.state, JSON.stringify(entry)).toEqual(before.state);
      expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
      verified++;
    }
    expect(verified).toBe(432);
  });

  it('every unfunded composition rejects without changing the complete context', () => {
    let verified = 0;
    for (const entry of cases) {
      if (entry.resource !== 'none' || entry.cost === '{0}') continue;
      const { ctx, player, card } = setup(entry);
      const before = cloneContractContext(ctx);
      expect(
        computePriorityOptions(ctx, player).some((option) => {
          const payload = option.payload as PriorityActionPayload;
          return payload.kind === 'castSpell' && payload.objectId === card.id;
        }),
        JSON.stringify(entry),
      ).toBe(false);
      expect(
        () =>
          pump(
            applyPriorityAction(
              ctx,
              player,
              { kind: 'castSpell', objectId: card.id, fromCommand: false },
              { index: 0, targets: new Map() },
            ),
          ),
        JSON.stringify(entry),
      ).toThrow();
      expect(ctx.state, JSON.stringify(entry)).toEqual(before.state);
      expect(ctx.debugLog).toEqual(before.debugLog);
      expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
      verified++;
    }
    expect(verified).toBe(144);
  });
});
