import type { PublicPressureEvent } from '@mtg/shared';

/** Directional, bounded and deliberately independent from strategic strength. */
export function recentPressure(
  events: readonly PublicPressureEvent[],
  actor: string,
  recipient: string,
  turn: number,
  seats: number,
): number {
  const seen = new Set<number>();
  return events.slice(-64).reduce((sum, event) => {
    if (
      seen.has(event.sequence) ||
      event.actor !== actor ||
      event.recipient !== recipient ||
      actor === recipient ||
      event.turn > turn
    )
      return sum;
    seen.add(event.sequence);
    return (
      sum +
      Math.min(20, Math.max(0, event.amount)) *
        Math.pow(0.7, (turn - event.turn) / Math.max(1, seats))
    );
  }, 0);
}
