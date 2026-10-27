import type { PermanentView, PlayerId, PlayerView } from '@mtg/shared';
import { opponent, view } from './fixtures.test-helpers';

/** A tiny mutable table for driving `DiplomacyTable` without an engine. Not a test file. */
export interface World {
  life: Record<PlayerId, number>;
  battlefield: PermanentView[];
  order: PlayerId[];
}

export function viewFrom(world: World, seat: PlayerId): PlayerView {
  const living = world.order.filter((s) => (world.life[s] ?? 0) > 0);
  const start = living.indexOf(seat);
  const opponents = [...living.slice(start + 1), ...living.slice(0, start)].map((s) =>
    opponent(s, world.life[s]!),
  );
  return view(seat, world.life[seat]!, opponents, world.battlefield);
}
