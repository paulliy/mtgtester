import type { PlayerId } from './ids';
import type { Phase, Step } from './enums';

/**
 * One entry in the replayable game log (brief §9 `game_events`). This is the internal,
 * complete event stream — distinct from the minimal spectator action log (brief §10.2)
 * and the debug log (brief §13), both of which are derived from it.
 *
 * TODO(phase-2): replace the open `type`/`payload` with a discriminated union, one variant
 * per event type, as mechanics are implemented. Kept open now so logging can start in
 * Phase 2 without the union being complete.
 */
export interface GameEvent {
  /** Monotonic per-game sequence number. */
  sequence: number;
  turn: number;
  phase: Phase;
  step: Step | null;
  /** The seat that caused the event, or null for game-driven events (SBAs, resolutions). */
  actorSeat: PlayerId | null;
  type: string;
  payload: Record<string, unknown>;
}
