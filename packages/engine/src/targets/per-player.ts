import type { PlayerId } from '@mtg/shared';
import type { Ability } from '../cards/ability';
import type { GameContext } from '../state/types';

/** Players still in the game, in turn order starting with `firstId` (CR 101.4). */
export function playersInTurnOrderFrom(ctx: GameContext, firstId: PlayerId): PlayerId[] {
  const order = ctx.state.turnOrder.filter(
    (id) => !(ctx.state.players.find((player) => player.id === id)?.hasLost ?? true),
  );
  const start = Math.max(0, order.indexOf(firstId));
  return [...order.slice(start), ...order.slice(0, start)];
}

/**
 * Expand an ability's `perPlayer` target into one optional slot for each player in the game as
 * the ability is put on the stack (CR 603.3d): "for each player, up to one target creature that
 * player controls" (Nils, Discipline Enforcer). Each slot is a variable-count slot of 0 to 1 that
 * only admits that player's permanents, and remembers the spec it came from so an effect naming
 * that spec acts on all of them. Without such a spec the ability is returned unchanged.
 */
export function expandPerPlayerTargets(
  ctx: GameContext,
  ability: Ability,
  controllerId: PlayerId,
): Ability {
  if (!ability.targets.some((spec) => spec.perPlayer === true)) return ability;
  const targets = ability.targets.flatMap((spec, index) => {
    if (spec.perPlayer !== true) return [spec];
    const { perPlayer: _perPlayer, controller: scope, ...rest } = spec;
    return playersInTurnOrderFrom(ctx, controllerId)
      .filter((id) => scope !== 'opponent' || id !== controllerId)
      .map((playerId) => ({
        ...rest,
        count: { min: 0, max: 1 },
        controllerPlayer: playerId,
        slotGroup: index,
      }));
  });
  return { ...ability, targets };
}
