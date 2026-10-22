import type { OracleCard } from '@mtg/shared';
import { expect } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';

export function searchPod(seed = 'multiplayer-search') {
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
  for (const player of ctx.state.players) {
    player.library = [];
    for (const suffix of ['First', 'Second', 'Chosen', 'Last'])
      conjure(
        ctx,
        player.id,
        oracle({ name: `${player.id} ${suffix} Relic`, typeLine: 'Artifact', manaCost: '{0}' }),
        'library',
      );
  }
  return ctx;
}

export function castSearch(
  ctx: GameContext,
  card: OracleCard,
  targets: readonly string[] = ['P1', 'P2'],
) {
  const object = conjure(ctx, 'P1', card, 'hand');
  addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
  const action = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((option) => {
    const data = option.payload as PriorityActionPayload;
    return data.kind === 'castSpell' && data.objectId === object.id;
  });
  expect(action, 'normal spell announcement is legal').toBeDefined();
  let picks = 0;
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), action!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
    (decision) => {
      expect(decision.prompt).toMatch(/^Choose target /);
      expect(decision.options.some((option) => option.type === 'decline')).toBe(false);
      if (picks > 0)
        expect(decision.options.map((option) => option.data?.['objectId'])).not.toContain(
          targets[0],
        );
      const index = decision.options.findIndex(
        (option) => option.data?.['objectId'] === targets[picks],
      );
      expect(index).toBeGreaterThanOrEqual(0);
      picks++;
      return { index, targets: new Map() };
    },
  );
  expect(picks).toBe(2);
  expect(ctx.state.stack).toHaveLength(1);
  expect(ctx.state.stack[0]?.countTargets?.[0]).toEqual(targets);
  expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  return object;
}

export function settleSearch(ctx: GameContext, inspect?: (decision: PendingDecision) => void) {
  const searched: string[] = [];
  pump(runPrioritySequence(ctx), (decision): DecisionOutcome => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    inspect?.(decision);
    expect(decision.options.every((option) => option.type === 'search')).toBe(true);
    searched.push(decision.player);
    const index = decision.options.findIndex(
      (option) => option.description === `Choose ${decision.player} Chosen Relic`,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    return { index, targets: new Map() };
  });
  expect(ctx.state.stack).toEqual([]);
  return searched;
}

export const shufflers = (ctx: GameContext) =>
  ctx.state.eventLog
    .filter((event) => event.type === 'shuffle')
    .map((event) => event.payload['player']);
