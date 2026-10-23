import { readFileSync } from 'node:fs';
import type { Color, OracleCard } from '@mtg/shared';
import { expect } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { ManaEntry } from '../src/cards/ability';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { registerCoveragePr10Overrides } from '../src/cards/overrides/coverage-pr10';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import type { EnginePermanent, EngineStackObject, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';

// Pending evidence, PR10 overrides are installed only in the PR10 suites' module graph.
registerCoveragePr10Overrides();

/** The 31 exact PR10 Oracle pins. */
export const PR10_PINS = (
  JSON.parse(
    readFileSync(new URL('./fixtures/coverage-pr10-oracle.json', import.meta.url), 'utf8'),
  ) as { cards: { sha256: string; card: OracleCard }[] }
).cards;
if (PR10_PINS.length !== 31) throw new Error('Expected 31 PR10 pins, found ' + PR10_PINS.length);

export function pinned(name: string): OracleCard {
  const pin = PR10_PINS.find((entry) => entry.card.name === name);
  if (pin === undefined) throw new Error('No PR10 pin for ' + name);
  return pin.card;
}

export function pinnedDefinition(name: string): CardDefinition {
  return interpretCard(pinned(name));
}

/** Four players with 24-card libraries; P1's precombat main phase with an empty stack. */
export function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(24, forest) })),
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
  for (const player of ctx.state.players) player.hand = [];
  return ctx;
}

export const p = (ctx: GameContext, id: string) => playerById(ctx, id);

/** Exactly the printed mana cost of `def`, colorless standing in for generic. */
export function exactMana(def: CardDefinition): ManaEntry[] {
  const cost = def.manaCost;
  if (cost === null) return [];
  const mana: ManaEntry[] = [];
  for (const color of ['W', 'U', 'B', 'R', 'G'] as const satisfies readonly Color[]) {
    for (let i = 0; i < cost.colored[color]; i++) mana.push({ symbol: color });
  }
  for (let i = 0; i < cost.colorless; i++) mana.push({ symbol: 'C' });
  for (const pip of cost.hybrid ?? []) mana.push({ symbol: pip[0]! });
  for (const pip of cost.phyrexian ?? []) mana.push({ symbol: pip });
  for (let i = 0; i < cost.generic; i++) mana.push({ symbol: 'C' });
  return mana;
}

export function castOption(
  ctx: GameContext,
  playerId: string,
  objectId: string,
  alternativeCast?: string,
) {
  return computePriorityOptions(ctx, p(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload & { alternativeCast?: string };
    return (
      option.type === 'castSpell' &&
      payload.kind === 'castSpell' &&
      payload.objectId === objectId &&
      payload.alternativeCast === alternativeCast
    );
  });
}

/** Lets `playerId` act now: their turn, main phase, priority. Returns a restore function. */
export function asActive(ctx: GameContext, playerId: string): () => void {
  const previous = {
    currentTurnPlayer: ctx.state.currentTurnPlayer,
    activePlayerIndex: ctx.state.activePlayerIndex,
  };
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.players.findIndex((player) => player.id === playerId);
  return () => Object.assign(ctx.state, previous);
}

/**
 * Cast `card` from `playerId`'s hand through the real priority action with exactly its printed
 * mana, choosing `targets` by slot. Returns the resulting stack object.
 */
export function castFromHand(
  ctx: GameContext,
  playerId: string,
  card: OracleCard,
  targets: Map<number, string> = new Map(),
  answer?: (decision: PendingDecision, count: number) => DecisionOutcome,
  extraMana: ManaEntry[] = [],
): EngineStackObject {
  const def = interpretCard(card);
  const inHand = conjure(ctx, playerId, card, 'hand');
  addMana(p(ctx, playerId), [...exactMana(def), ...extraMana]);
  const option = castOption(ctx, playerId, inHand.id);
  expect(option, `${card.name} is castable by ${playerId}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, p(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
    answer,
  );
  const entry = ctx.state.stack.find((item) => item.sourceCardId === inHand.cardId);
  if (entry === undefined) throw new Error(`${card.name} is not on the stack`);
  return entry;
}

/** "Lab Shock deals 2 damage to any target." */
export const labShock = (): OracleCard =>
  oracle({
    name: 'Lab Shock',
    typeLine: 'Instant',
    manaCost: '{R}',
    cmc: 1,
    colors: ['R'],
    power: null,
    toughness: null,
    oracleText: 'Lab Shock deals 2 damage to any target.',
  });

export const bear = (name: string, extra: Partial<OracleCard> = {}): OracleCard =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2', ...extra });

/** Pick the decision option whose description matches; throws listing the options otherwise. */
export function choose(pattern: RegExp | string) {
  return (decision: PendingDecision): DecisionOutcome => {
    const index = decision.options.findIndex((option) =>
      typeof pattern === 'string'
        ? option.description.includes(pattern)
        : pattern.test(option.description),
    );
    if (index < 0)
      throw new Error(
        `no option matching ${String(pattern)} in ${decision.prompt}: ${decision.options
          .map((option) => option.description)
          .join(' | ')}`,
      );
    return { index, targets: new Map() };
  };
}

/** State-based actions, then waiting triggers onto the stack (CR 117.5). */
export function putPendingTriggersOnStack(
  ctx: GameContext,
  answer?: (decision: PendingDecision, count: number) => DecisionOutcome,
) {
  pump(priorityCheckpoint(ctx), answer);
}

/** Resolve until the stack and pending triggers are empty. */
export function settle(
  ctx: GameContext,
  answer?: (decision: PendingDecision, count: number) => DecisionOutcome,
) {
  for (let guard = 0; guard < 50; guard++) {
    putPendingTriggersOnStack(ctx, answer);
    if (ctx.state.stack.length === 0) return;
    pump(resolveTopOfStack(ctx), answer);
  }
  throw new Error('stack did not settle');
}

export function activateOption(
  ctx: GameContext,
  playerId: string,
  source: EnginePermanent,
  index = 0,
) {
  return computePriorityOptions(ctx, p(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload & { index?: number };
    return (
      payload.kind === 'activateAbility' &&
      payload.objectId === source.id &&
      (payload.index ?? 0) === index
    );
  });
}

/** Activate `source`'s ability through the real priority action; returns its stack object. */
export function activate(
  ctx: GameContext,
  playerId: string,
  source: EnginePermanent,
  targets: Map<number, string> = new Map(),
  answer?: (decision: PendingDecision, count: number) => DecisionOutcome,
): EngineStackObject {
  const option = activateOption(ctx, playerId, source);
  expect(option, `${source.name} activation is offered to ${playerId}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, p(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
    answer,
  );
  const entry = ctx.state.stack.findLast(
    (item) => item.kind === 'activatedAbility' && item.sourceCardId === source.cardId,
  );
  if (entry === undefined) throw new Error(`${source.name}'s ability is not on the stack`);
  return entry;
}
