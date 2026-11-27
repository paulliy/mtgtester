import type { PlayerBoardState } from '@mtg/shared';

/**
 * Ids of every object the player board draws as something you can click: your hand, every
 * permanent, commanders waiting in the command zone, every graveyard and exile pile, and library
 * tops you can see. A choice the engine ties to an object outside this set (a card in a hidden
 * zone, a card seen in another player's hand) has nothing on screen to click, so the board lists
 * it in the decision panel instead of waiting for a click that can never come.
 */
export function clickableObjectIds(board: PlayerBoardState | null): Set<string> {
  const ids = new Set<string>();
  if (board === null) return ids;
  for (const permanent of board.battlefield) ids.add(permanent.id);
  for (const card of board.exile) ids.add(card.id);
  for (const entry of board.revealedLibraryTops ?? []) ids.add(entry.card.id);
  for (const seat of board.seats) {
    for (const card of seat.graveyard) ids.add(card.id);
    if (seat.seat === board.viewerSeat) for (const card of seat.hand ?? []) ids.add(card.id);
    for (const commander of seat.commanders) {
      if (commander.zone === 'command' && commander.objectId !== null) ids.add(commander.objectId);
    }
  }
  return ids;
}
