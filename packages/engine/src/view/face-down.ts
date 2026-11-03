import type { EngineCardObject } from '../state/types';

/**
 * May this player look at this face-down exiled card (CR 406.3)? The players an effect names
 * ("you may cast that card", Gonti) when it names any, otherwise its owner (hideaway, foretell).
 */
export function faceDownExileVisibleTo(card: EngineCardObject, playerId: string): boolean {
  return card.faceDownVisibleTo !== undefined
    ? card.faceDownVisibleTo.includes(playerId)
    : card.ownerId === playerId;
}
