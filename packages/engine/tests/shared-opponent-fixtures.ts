import type { OracleCard } from '@mtg/shared';
import { expect } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

export function sharedOpponentPod(seed = 'shared-opponent') {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 5,
    phase: 'precombatMain',
    step: null,
  });
  for (const player of ctx.state.players)
    spawn(
      ctx,
      player.id,
      oracle({
        name: `${player.id} Witness Bear`,
        typeLine: 'Creature — Bear',
        power: '2',
        toughness: '2',
      }),
    );
  return ctx;
}
export function castSharedOpponentSpell(ctx: GameContext, card: OracleCard) {
  const object = conjure(ctx, 'P1', card, 'hand');
  addMana(playerById(ctx, 'P1'), [
    { symbol: 'W' },
    { symbol: 'C' },
    { symbol: 'C' },
    { symbol: 'C' },
  ]);
  const action = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(action, 'printed cost is payable through the normal cast menu').toBeDefined();
  expect(action!.targets ?? []).toEqual([]);
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), action!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  expect(ctx.state.stack[0]?.targets).toEqual([]);
  expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  return object;
}
export function settleSharedOpponentSpell(
  ctx: GameContext,
  recipients = ['P2', 'P3'],
  inspect?: (decision: PendingDecision, index: number) => void,
) {
  let picks = 0;
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'orderTriggers') return { index: 0, targets: new Map() };
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    expect(decision.player).toBe('P1');
    expect(decision.options.every((option) => option.type === 'choosePlayer')).toBe(true);
    expect(decision.options.some((option) => option.description.startsWith('P1 '))).toBe(false);
    inspect?.(decision, picks);
    const index = decision.options.findIndex((option) =>
      option.description.startsWith(`${recipients[picks]} `),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    picks++;
    return { index, targets: new Map() };
  });
  expect(ctx.state.stack).toEqual([]);
  return picks;
}
