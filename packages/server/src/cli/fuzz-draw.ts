/**
 * A drawn game in fuzz (issue #46). The engine halts on a draw (brief §4: zero survivors is more
 * often a rules bug than a real result), and fuzz used to fail every one. A draw is a real result
 * when the last players all lose to the same state-based action check (CR 104.4a): an Earthquake
 * for more than both remaining players' life totals (fuzz-26). Fuzz accepts a draw only when it can
 * check that against the final state: the final losses came together, every remaining player was
 * among them, and each one's recorded reason matches what the state shows. Anything it cannot
 * check (a "you lose the game" effect, an unrecorded reason) still fails as a halt.
 */
import { COMMANDER_DAMAGE_LETHAL, type PlayerId } from '@mtg/shared';

export const DRAW_HALT_REASON = 'all remaining players lost simultaneously (draw)';

/** The parts of the final engine state the check reads. */
export interface DrawState {
  players: ReadonlyArray<{
    id: PlayerId;
    life: number;
    poisonCounters: number;
    commanderDamageTaken: Readonly<Record<string, number>>;
    hasLost: boolean;
    lossReason: string | null;
  }>;
  eliminatedPlayers: readonly PlayerId[];
  eventLog: ReadonlyArray<{ type: string; payload?: unknown }>;
}

/**
 * Events one elimination pass emits besides `playerEliminated` (CR 800.4a: the departed players'
 * objects leave the game, the monarch passes on) and the game's end.
 */
const ELIMINATION_EVENTS: ReadonlySet<string> = new Set([
  'playerEliminated',
  'zoneChange',
  'tokenCeased',
  'cardCopyCeased',
  'monarch',
  'gameOver',
  'engineHalt',
]);

/** Does the state show the loss it records (CR 704.5a-c, 903.10a)? */
function lossShown(player: DrawState['players'][number]): boolean {
  switch (player.lossReason) {
    case 'lifeZeroOrLess':
      return player.life <= 0;
    case 'poisonCounters':
      return player.poisonCounters >= 10;
    case 'commanderDamage':
      return Object.values(player.commanderDamageTaken).some(
        (damage) => damage >= COMMANDER_DAMAGE_LETHAL,
      );
    // The attempted draw is cleared as the player leaves, and nothing else records it: the loss
    // reason is the only record, set by the same check.
    case 'emptyLibraryDraw':
      return true;
    default:
      return false;
  }
}

/**
 * The players who drew and why, or the reason the draw cannot be accepted. Reads only the final
 * state: the last players eliminated with no other event between them form the final check.
 */
export function verifyDraw(
  state: DrawState,
): { players: Array<{ player: PlayerId; reason: string }> } | { unverified: string } {
  const finalPass: PlayerId[] = [];
  for (let index = state.eventLog.length - 1; index >= 0; index--) {
    const event = state.eventLog[index]!;
    if (!ELIMINATION_EVENTS.has(event.type)) break;
    if (event.type === 'playerEliminated')
      finalPass.push((event.payload as { player: PlayerId }).player);
  }
  if (finalPass.length < 2)
    return { unverified: 'the final check eliminated fewer than two players' };
  const last = new Set(state.eliminatedPlayers.slice(-finalPass.length));
  if (finalPass.some((id) => !last.has(id)) || state.players.some((p) => !p.hasLost))
    return { unverified: 'a player outside the final check was still in the game' };
  const players = finalPass.reverse().map((id) => state.players.find((p) => p.id === id)!);
  const unshown = players.find((player) => !lossShown(player));
  if (unshown !== undefined)
    return {
      unverified: `${unshown.id}'s loss (${unshown.lossReason ?? 'no reason'}) does not show in the final state`,
    };
  return { players: players.map((p) => ({ player: p.id, reason: p.lossReason! })) };
}
