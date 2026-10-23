/** Shared harness for the PR12 behavior tests: the pinned reopened cards and the PR11 game helpers. */
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { fixtureOracleId } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { pump } from './fixtures';
import { player, priorityOption } from './pr11-helpers';

export {
  anyMana,
  battlefield,
  castFromHand,
  checkpoint,
  game,
  nextTurnOf,
  offeredTargets,
  player,
  priorityOption,
  resolve,
} from './pr11-helpers';

export const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr12-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

export function pinned(name: string): OracleCard {
  const entry = fixture.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned PR12 card ${name}`);
  return entry.card;
}

/** The same pinned card under its `oracle-<slug>` fixture identity. */
export function alias(card: OracleCard): OracleCard {
  return { ...card, oracleId: fixtureOracleId(card.name) as OracleCard['oracleId'] };
}

/** Activate the `index`th activated ability of `source` through the priority menu. */
export function activateIndex(
  ctx: GameContext,
  playerId: string,
  source: EnginePermanent,
  index: number,
  answer?: (decision: PendingDecision, count: number) => DecisionOutcome,
): void {
  const option = priorityOption(
    ctx,
    playerId,
    (payload) =>
      payload.kind === 'activateAbility' &&
      payload.objectId === source.id &&
      payload.index === index,
  );
  expect(option, `activate ${source.name} #${index}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
    answer,
  );
}

/** Answer each decision by the option whose description matches, else the first option. */
export function choosing(
  ...patterns: (RegExp | string)[]
): (decision: PendingDecision) => DecisionOutcome {
  return (decision) => {
    for (const pattern of patterns) {
      const index = decision.options.findIndex((option) =>
        typeof pattern === 'string'
          ? option.description === pattern
          : pattern.test(option.description),
      );
      if (index >= 0) return { index, targets: new Map() };
    }
    return { index: 0, targets: new Map() };
  };
}
