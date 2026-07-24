import type { ObjectId } from './ids';

/**
 * A continuous effect for the layer system (CR 613).
 *
 * TODO(phase-2): this is a placeholder so `GameState.effects` has a type. The real model
 * needs layers (1–7), sublayers, timestamps, dependency ordering, and characteristic-
 * defining abilities. Do not build this until Phase 2 engine work reaches continuous effects.
 */
export interface ContinuousEffect {
  id: string;
  sourceId: ObjectId;
  /** Human-readable description for the debug log until the layer model lands. */
  description: string;
}
