/**
 * The New game compass's angle maths (redesign plan, phase 3a; `Main.dc.html`). Pure, so the
 * turning rules are unit-tested without a browser. Angles are degrees, clockwise from north.
 */

/** An angle folded into [0, 360). */
export function wrap(angle: number): number {
  const folded = angle % 360;
  return folded < 0 ? folded + 360 : folded;
}

/** The signed turn from one angle to another that takes the short way: (-180, 180]. */
export function shortestTurn(from: number, to: number): number {
  const delta = wrap(to - from);
  return delta > 180 ? delta - 360 : delta;
}

/**
 * The plate's next rotation when `stopAngle` should come to north. Rotations are cumulative:
 * the plate turns the short way from where it already is, so repeated choices add turns rather
 * than snapping back through zero.
 */
export function plateTarget(currentRotation: number, stopAngle: number): number {
  return currentRotation + shortestTurn(currentRotation, -stopAngle);
}

/**
 * Where a ring lands after a change: about one full turn in its own direction, then on the
 * nearest quarter, so the rings always come to rest square.
 */
export function ringLanding(current: number, direction: 1 | -1): number {
  const target = current + direction * 360;
  return Math.round(target / 90) * 90;
}

/** The pointer's bearing from the face's centre, clockwise from north. */
export function bearing(dx: number, dy: number): number {
  return wrap((Math.atan2(dx, -dy) * 180) / Math.PI);
}

export const SNAP_ON_DEGREES = 12;
export const SNAP_OFF_DEGREES = 17;

/**
 * The needle's lean while the pointer is over the face: it follows the pointer, snaps onto a
 * stop within `SNAP_ON_DEGREES`, and holds that stop until the pointer is `SNAP_OFF_DEGREES`
 * away. Returns the needle angle and the stop it holds, if any.
 */
export function needleLean(
  pointer: number,
  stops: readonly number[],
  held: number | null,
): { angle: number; held: number | null } {
  if (held !== null && Math.abs(shortestTurn(held, pointer)) <= SNAP_OFF_DEGREES) {
    return { angle: held, held };
  }
  for (const stop of stops) {
    if (Math.abs(shortestTurn(stop, pointer)) <= SNAP_ON_DEGREES)
      return { angle: stop, held: stop };
  }
  return { angle: pointer, held: null };
}

/** The needle's next cumulative angle: from where it is, the short way to `target`. */
export function needleTarget(current: number, target: number): number {
  return current + shortestTurn(current, target);
}
