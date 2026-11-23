/**
 * Battlefield object ids of every seat's commanders. Boards group permanents by their current
 * controller, so a commander another seat has taken control of sits in that seat's panel: the
 * frame has to come from every seat's commanders, not only the panel's own.
 */
export function commanderObjectIds(
  seats: readonly { commanders: readonly { objectId: string | null }[] }[],
): Set<string> {
  const ids = new Set<string>();
  for (const seat of seats) {
    for (const commander of seat.commanders) {
      if (commander.objectId !== null) ids.add(commander.objectId);
    }
  }
  return ids;
}
