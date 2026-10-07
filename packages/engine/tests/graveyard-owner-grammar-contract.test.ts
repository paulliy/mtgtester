import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

describe('graveyard ownership in generic return clauses', () => {
  it.each(['your', 'a'] as const)(
    'normally casts a return from %s graveyard against the printed owner scope',
    (owner) => {
      const state = setup(owner);
      const option = state.offered()!;
      expect(option).toBeDefined();
      expect(option.targets![0]!.options).toEqual(
        owner === 'your' ? [state.own.id] : [state.own.id, state.other.id],
      );
      const selected = owner === 'your' ? state.own : state.other;
      pump(
        applyPriorityAction(state.ctx, state.player, option.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map([[0, selected.id]]),
        }),
      );
      pump(resolveTopOfStack(state.ctx));
      expect(
        state.ctx.state.players
          .find((player) => player.id === selected.ownerId)!
          .hand.some((card) => card.cardId === selected.cardId),
      ).toBe(true);
    },
  );
  it('rejects a foreign graveyard response to your graveyard before mutation', () => {
    const state = setup('your');
    const before = cloneContractContext(state.ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          state.ctx,
          state.player,
          state.offered()!.payload as PriorityActionPayload,
          { index: 0, targets: new Map([[0, state.other.id]]) },
        ),
      ),
    ).toThrow();
    expect(state.ctx.state).toEqual(before.state);
    expect(state.ctx.rng.nextUint32()).toEqual(before.rng.nextUint32());
  });
  it.each(['the battlefield', 'your hand'])(
    'does not claim a collective return from an unspecified graveyard to %s',
    (destination) => {
      const card = oracle({
        name: 'Independent collective owner probe',
        typeLine: 'Sorcery',
        manaCost: '{0}',
        oracleText: `Return all creature cards from a graveyard to ${destination}.`,
      });
      expect(interpretCard(card).modeled).toBe(false);
    },
  );
});

function setup(owner: 'your' | 'a') {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const card = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Independent graveyard grammar probe',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: `Return target creature card from ${owner} graveyard to your hand.`,
    }),
    'hand',
  );
  const own = conjure(ctx, 'P1', bear(), 'graveyard');
  const other = conjure(ctx, 'P2', bear(), 'graveyard');
  const offered = () =>
    computePriorityOptions(ctx, player).find(
      (option) => (option.payload as { objectId?: string }).objectId === card.id,
    );
  return { ctx, player, own, other, offered };
}
