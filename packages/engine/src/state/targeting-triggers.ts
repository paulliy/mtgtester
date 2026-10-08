import type { ObjectId, PlayerId } from '@mtg/shared';
import type { WardCost } from '../cards/ability';
import { debug } from '../log/log';
import { describeManaCost } from '../mana/cost';
import { additionalTypedTriggerCopies, queueTriggersForEvent } from './objects';
import { wardCostOf } from './queries';
import type { EnginePermanent, GameContext } from './types';

/**
 * Ward (CR 702.21b): "whenever this becomes the target of a spell or ability an opponent
 * controls, counter it unless that player pays `<cost>`".
 *
 * Modeled as a *triggered ability*, not as a targeting restriction, and that is the load-bearing
 * decision. "Unless the controller pays" is a decision, and `isTargetStillLegal` — the function
 * a legality filter would have to live in — is a pure predicate that cannot ask a player
 * anything. As a trigger it also behaves correctly: it goes on the stack above the spell, so
 * the spell is still countered if ward resolves, and other responses can happen in between.
 */
export function queueWardTriggers(
  ctx: GameContext,
  controllerId: PlayerId,
  stackObjectId: ObjectId,
  targets: readonly ObjectId[],
): void {
  for (const targetId of targets) {
    const perm = ctx.state.battlefield.find((p) => p.id === targetId);
    if (perm === undefined) continue;
    // "an opponent controls" — a permanent's own controller never triggers its ward.
    if (perm.controllerId === controllerId) continue;
    const cost = wardCostOf(ctx, perm);
    if (cost === null) continue;
    const costDescription = describeWardCost(cost);

    const copies = 1 + additionalTypedTriggerCopies(ctx, perm);
    for (let copy = 0; copy < copies; copy++) {
      ctx.state.pendingTriggers.push({
        controllerId: perm.controllerId,
        sourceCardId: perm.cardId,
        sourceObjectId: perm.id,
        sourceOracleId: perm.oracleId,
        sourceName: perm.name,
        ability: {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'counterUnlessPays', cost, stackObjectId }],
          description: `ward—${costDescription}`,
        },
      });
      debug(ctx, 'stack', `ward triggered: ${perm.name} (${costDescription})`);
    }
  }
}

function describeWardCost(cost: WardCost): string {
  return cost.kind === 'mana' ? describeManaCost(cost.cost) : `pay ${cost.amount} life`;
}

/**
 * "Becomes the target of a spell or ability" (Thunderbreak Regent, CR 603.3d) — every
 * permanent named in `targets` just became a target, regardless of whose. `queueTriggersForEvent`
 * itself enforces "an opponent controls" against `sourceControllerId`.
 */
export function queueBecomesTargetedTriggers(
  ctx: GameContext,
  sourceControllerId: PlayerId,
  targets: readonly ObjectId[],
): void {
  const subjects = targets
    .map((id) => ctx.state.battlefield.find((p) => p.id === id))
    .filter((p): p is EnginePermanent => p !== undefined)
    .map((permanent) => ({ permanent, sourceControllerId }));
  queueTriggersForEvent(ctx, 'becomesTargeted', subjects);
}
