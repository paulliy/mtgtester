import type { EngineCardObject, EngineStackObject, GameContext } from '../state/types';

/** CR 601.2a projection for pure previews: the card has already left its source zone. */
export function castingPreviewContext(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId = card.ownerId,
): GameContext {
  const proposedCard: EngineCardObject = {
    ...card,
    id: `o-${ctx.state.nextObjectNum}`,
    zone: 'stack',
  };
  const proposed: EngineStackObject = {
    id: proposedCard.id,
    sourceId: proposedCard.id,
    sourceCardId: card.cardId,
    sourceOracleId: card.oracleId,
    controllerId,
    kind: 'spell',
    description: card.name,
    card: proposedCard,
    ability: null,
    targets: [],
    isCommanderCast: card.zone === 'command',
    castInProgress: true,
  };
  const without = (cards: EngineCardObject[]) => cards.filter((entry) => entry !== card);
  return {
    ...ctx,
    state: {
      ...ctx.state,
      exile: without(ctx.state.exile),
      players: ctx.state.players.map((player) =>
        player.id === card.ownerId
          ? {
              ...player,
              hand: without(player.hand),
              graveyard: without(player.graveyard),
              library: without(player.library),
              commandZone: without(player.commandZone),
            }
          : player,
      ),
      stack: [...ctx.state.stack, proposed],
    },
  };
}
