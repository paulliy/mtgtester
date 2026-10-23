/** Shared harness for the PR11 behavior tests: pinned cards, a four-player game, cast and combat. */
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { runCombatPhase } from '../src/combat/combat';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../src/state/types';
import type { PendingDecision } from '../src/decisions';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  gameConfig,
  plains,
  pump,
} from './fixtures';

export const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr11-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

export function pinned(name: string): OracleCard {
  const entry = fixture.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned PR11 card ${name}`);
  return entry.card;
}

export function game(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(10, plains) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

export function player(ctx: GameContext, id: string): EnginePlayerState {
  const found = ctx.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing player ${id}`);
  return found;
}

export function anyMana(ctx: GameContext, playerId: string, count: number): void {
  addMana(
    player(ctx, playerId),
    Array.from({ length: count }, () => ({ symbol: 'C' as const })),
  );
}

/** Find a priority option by payload predicate, for the normal cast/activation path. */
export function priorityOption(
  ctx: GameContext,
  playerId: string,
  match: (payload: PriorityActionPayload) => boolean,
) {
  return computePriorityOptions(ctx, player(ctx, playerId)).find((entry) =>
    match(entry.payload as PriorityActionPayload),
  );
}

export function castFromHand(
  ctx: GameContext,
  playerId: string,
  card: OracleCard,
  targets: ReadonlyMap<number, string> = new Map(),
  mana: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>> = {},
  answer?: Parameters<typeof pump>[1],
): void {
  const object = conjure(ctx, playerId, card, 'hand');
  addMana(
    player(ctx, playerId),
    Object.entries(mana).flatMap(([symbol, count]) =>
      Array.from({ length: count }, () => ({ symbol: symbol as 'W' })),
    ),
  );
  const option = priorityOption(
    ctx,
    playerId,
    (payload) => payload.kind === 'castSpell' && payload.objectId === object.id,
  );
  expect(option, `cast ${card.name}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
    answer,
  );
}

/** The targets the priority menu offers for one slot of a cast or activation. */
export function offeredTargets(
  ctx: GameContext,
  playerId: string,
  match: (payload: PriorityActionPayload) => boolean,
  slot = 0,
): string[] {
  const option = priorityOption(ctx, playerId, match);
  if (option === undefined) return [];
  return [...(option.targets?.find((entry) => entry.slot === slot)?.options ?? [])];
}

export function activate(
  ctx: GameContext,
  playerId: string,
  source: EnginePermanent,
  targets: ReadonlyMap<number, string> = new Map(),
): void {
  const option = priorityOption(
    ctx,
    playerId,
    (payload) => payload.kind === 'activateAbility' && payload.objectId === source.id,
  );
  expect(option, `activate ${source.name}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
}

export function resolve(ctx: GameContext): PendingDecision[] {
  return pump(resolveTopOfStack(ctx)).decisions;
}

/** State-based actions, then pending triggers onto the stack (CR 117.5). */
export function checkpoint(ctx: GameContext): void {
  pump(priorityCheckpoint(ctx));
}

export function battlefield(ctx: GameContext, name: string): EnginePermanent[] {
  return ctx.state.battlefield.filter((permanent) => permanent.name === name);
}

/** Run one combat with `attacker` attacking `defender`, `blocker` blocking if it may. */
export function combat(
  ctx: GameContext,
  attacker: EnginePermanent,
  defender: string,
  blocker?: EnginePermanent,
): { blockable: string[] } {
  ctx.state.phase = 'combat';
  let blockable: string[] = [];
  pump(runCombatPhase(ctx), (decision) => {
    if (decision.decisionType === 'declareAttackers')
      return declareAttacks(decision, (id) => (id === attacker.id ? defender : null));
    if (decision.decisionType === 'declareBlockers')
      return declareBlocks(decision, (id, subject) => {
        if (blocker === undefined || id !== blocker.id) return null;
        blockable = subject.attackers.map((entry) => entry.attackerId);
        return blockable.includes(attacker.id) ? attacker.id : null;
      });
    return undefined as never;
  });
  return { blockable };
}
