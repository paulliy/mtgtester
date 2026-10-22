import { gatherRuleStatics } from '../state/queries';
import type { EngineCardObject, GameContext } from '../state/types';

/** Only identities a current rules effect allows this player to see. */
export function visibleLibraryTops(
  ctx: GameContext,
  viewerId: string,
): { player: string; card: EngineCardObject }[] {
  const statics = gatherRuleStatics(ctx);
  return ctx.state.players.flatMap((player) => {
    const top = player.library[0];
    const visible = statics.some(
      (entry) =>
        entry.controllerId === player.id &&
        (entry.static.kind === 'revealTopLibrary' ||
          (entry.static.kind === 'lookTopLibrary' && player.id === viewerId)),
    );
    return top !== undefined && visible ? [{ player: player.id, card: top }] : [];
  });
}
