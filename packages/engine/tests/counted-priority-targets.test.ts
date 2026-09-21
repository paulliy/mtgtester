import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

function setup(seed: string) {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.turnNumber = 2;
  const card = oracle({ name: 'Selective Blessing', typeLine: 'Sorcery', manaCost: '{0}' });
  const spell = conjure(ctx, 'P1', card, 'hand');
  registerCustomDef(ctx, {
    ...interpretCard(card),
    modeled: true,
    unmodeledReasons: [],
    spellAbility: {
      kind: 'spell',
      targets: [{ kind: 'creature', count: { min: 0, max: 2 } }],
      effects: [{ op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 }],
    },
  });
  const first = spawn(ctx, 'P1', bear());
  const second = spawn(ctx, 'P1', bear());
  const player = ctx.state.players[0]!;
  const action = computePriorityOptions(ctx, player).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === spell.id;
  });
  expect(action).toBeDefined();
  expect(action?.targets).toBeUndefined();
  return { ctx, player, action: action!, first, second };
}

describe('counted spell targets at announcement', () => {
  it('stores two distinct targets on the stack and resolves both', () => {
    const { ctx, player, action, first, second } = setup('counted-spell-two');
    const chosen = [first.id, second.id];
    const { decisions } = pump(
      applyPriorityAction(ctx, player, action.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      () => ({ index: 0, targets: new Map() }),
    );
    expect(decisions).toHaveLength(2);
    expect(ctx.state.stack[0]?.countTargets?.[0]).toEqual(chosen);
    pump(resolveTopOfStack(ctx));
    expect(first.counters['+1/+1']).toBe(1);
    expect(second.counters['+1/+1']).toBe(1);
  });

  it('allows zero targets and still casts the spell', () => {
    const { ctx, player, action, first, second } = setup('counted-spell-zero');
    pump(
      applyPriorityAction(ctx, player, action.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      (decision) => ({
        index: decision.options.findIndex((option) => option.type === 'decline'),
        targets: new Map(),
      }),
    );
    expect(ctx.state.stack[0]?.countTargets?.[0]).toEqual([]);
    pump(resolveTopOfStack(ctx));
    expect(first.counters['+1/+1'] ?? 0).toBe(0);
    expect(second.counters['+1/+1'] ?? 0).toBe(0);
  });
});
