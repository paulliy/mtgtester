/**
 * Placement and release rules for AI reasoning annotations (ADR 0022).
 *
 * Separated from `MatchSession` because this is where the hidden-information boundary is decided,
 * and a boundary that matters is worth being a named, directly-testable unit rather than a branch
 * inside a send method.
 */

import type { AiAnnotation, GameMode, SpectatorLogLine } from '@mtg/shared';

export interface AnnotationRelease {
  /** Safe to send with this batch of lines, already snapped to a line the viewer can see. */
  due: AiAnnotation[];
  /** Not yet placeable — keep for a later batch. */
  held: AiAnnotation[];
}

export interface AnnotationReleaseOptions {
  gameMode: GameMode;
  /** `DebugFlags.showAIResponses` — reasoning is opt-in and off by default. */
  showReasoning: boolean;
  pending: readonly AiAnnotation[];
  lines: readonly SpectatorLogLine[];
}

/**
 * Decide which pending annotations may ride along with `lines`.
 *
 * Two rules do the work:
 *
 *   1. **Single-player withholds everything.** Live opponent reasoning is hidden information —
 *      "holding removal for your commander" would decide the human's next turn for them. A player
 *      game releases the whole set at game over instead, so nothing is ever dropped, only delayed.
 *   2. **An annotation snaps forward to the first line at or after its anchor.** A decision's
 *      first event is frequently invisible (a pass logs nothing), so anchoring strictly would
 *      collect reasoning that never appears. Anything anchored past the end of this batch is held
 *      rather than snapped backward, which would show reasoning before the play it explains.
 */
export function releaseAnnotations(options: AnnotationReleaseOptions): AnnotationRelease {
  const { gameMode, showReasoning, pending, lines } = options;
  const held = [...pending];

  if (gameMode === 'singlePlayer' || !showReasoning) return { due: [], held };
  if (pending.length === 0 || lines.length === 0) return { due: [], held };

  const sequences = lines.map((line) => line.sequence).sort((a, b) => a - b);
  const last = sequences[sequences.length - 1] as number;

  const due: AiAnnotation[] = [];
  const stillHeld: AiAnnotation[] = [];
  for (const annotation of pending) {
    if (annotation.sequence > last) {
      stillHeld.push(annotation);
      continue;
    }
    const anchor = sequences.find((sequence) => sequence >= annotation.sequence);
    due.push(anchor === undefined ? annotation : { ...annotation, sequence: anchor });
  }
  return { due, held: stillHeld };
}
