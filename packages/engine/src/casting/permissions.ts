import type { EngineCardObject, EnginePlayerState } from '../state/types';

/** CR 903.8: ordinary command-zone casting permission belongs to the designated owner. */
export function mayCastCommanderFromCommand(
  player: EnginePlayerState,
  card: EngineCardObject,
): boolean {
  return (
    card.zone === 'command' &&
    card.ownerId === player.id &&
    card.isCommander &&
    player.commanderCardIds.includes(card.cardId)
  );
}
