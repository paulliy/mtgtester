import { describe, expect, it } from 'vitest';
import { SOLDIER_1_1 } from '../src/cards/tokens';
import { createGame } from '../src/state/game';
import {
  changeController,
  createToken,
  moveObject,
  movePermanentsTogether,
  playerById,
} from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function setup(
  sourceKind: 'ordinary permanent' | 'token' = 'ordinary permanent',
  sacrifice = false,
) {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      {
        seed: 'control-departure-observer-contract',
      },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;

  const watcher = spawn(
    ctx,
    'P2',
    oracle({
      name: 'Death Observer',
      typeLine: 'Creature — Test',
      oracleText: sacrifice
        ? 'Whenever you sacrifice a creature, draw a card.'
        : 'Whenever a creature you control dies, you gain 1 life.',
    }),
  );
  const source =
    sourceKind === 'token'
      ? createToken(ctx, SOLDIER_1_1, 'P1')
      : spawn(ctx, 'P1', oracle({ name: 'Control Duration Source', typeLine: 'Creature — Test' }));
  changeController(ctx, watcher, 'P1', {
    kind: 'whileSourceOnBattlefield',
    sourceObjectId: source.id,
  });
  return { ctx, source, watcher };
}

describe('departure observers retain the pre-departure controller', () => {
  it('plans every library position before an earlier departure ends source-bound control', () => {
    const { ctx, source, watcher } = setup();
    const planned: string[] = [];
    pump(
      movePermanentsTogether(ctx, [source, watcher], (permanent) => {
        planned.push(permanent.id);
        return permanent.id === source.id
          ? { zone: 'graveyard' }
          : {
              zone: 'library',
              libraryPosition: permanent.controllerId === 'P1' ? 'top' : 'bottom',
            };
      }),
    );
    expect(planned).toEqual([source.id, watcher.id]);
    expect(playerById(ctx, 'P2').library[0]!.cardId).toBe(watcher.cardId);
  });

  it.each(['ordinary permanent', 'token'] as const)(
    'queues and resolves a death trigger for a %s before source-bound control expires',
    (kind) => {
      const { ctx, source, watcher } = setup(kind);
      const p1Life = ctx.state.players.find((player) => player.id === 'P1')!.life;
      const p2Life = ctx.state.players.find((player) => player.id === 'P2')!.life;

      const destination = pump(moveObject(ctx, source, { zone: 'graveyard' })).value;

      expect(watcher.controllerId).toBe('P2');
      expect(ctx.state.pendingTriggers).toHaveLength(1);
      const trigger = ctx.state.pendingTriggers[0]!;
      expect(trigger.sourceCardId).toBe(watcher.cardId);
      expect(trigger.controllerId).toBe('P1');
      expect(trigger.scope?.eventObjectId).toBe(source.id);
      if (kind === 'ordinary permanent') {
        expect(destination).not.toBeNull();
        expect(destination!.zone).toBe('graveyard');
        expect(trigger.scope?.eventObjectDestinationId).toBe(destination!.id);
      } else {
        expect(destination).toBeNull();
        expect(trigger.scope?.eventObjectDestinationId).toBeUndefined();
      }

      pump(runPrioritySequence(ctx));
      expect(ctx.state.pendingTriggers).toHaveLength(0);
      expect(ctx.state.stack).toHaveLength(0);
      expect(ctx.state.players.find((player) => player.id === 'P1')!.life).toBe(p1Life + 1);
      expect(ctx.state.players.find((player) => player.id === 'P2')!.life).toBe(p2Life);
    },
  );

  it.each(['ordinary permanent', 'token'] as const)(
    'captures a sacrifice observer before its %s control source leaves',
    (kind) => {
      const { ctx, source, watcher } = setup(kind, true);
      const handBefore = ctx.state.players.find((player) => player.id === 'P1')!.hand.length;
      pump(moveObject(ctx, source, { zone: 'graveyard', reason: 'sacrifice' }));
      expect(watcher.controllerId).toBe('P2');
      expect(ctx.state.pendingTriggers).toHaveLength(1);
      expect(ctx.state.pendingTriggers.every((trigger) => trigger.controllerId === 'P1')).toBe(
        true,
      );
      pump(runPrioritySequence(ctx));
      expect(ctx.state.players.find((player) => player.id === 'P1')!.hand).toHaveLength(
        handBefore + 1,
      );
    },
  );

  it('does not trigger when the source leaves for hand', () => {
    const { ctx, source, watcher } = setup();

    const destination = pump(moveObject(ctx, source, { zone: 'hand' })).value;

    expect(destination).not.toBeNull();
    expect(destination!.zone).toBe('hand');
    expect(watcher.controllerId).toBe('P2');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});
