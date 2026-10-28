/**
 * Exhaustive dispatch on a closed union. Every branch on `GameMode` ends in this, so adding a
 * mode fails typecheck until each branch is decided, and an unknown runtime value (a corrupt
 * row, a hostile frame) fails closed instead of falling into whichever branch came last.
 */
export function assertNever(value: never, context = 'unhandled variant'): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}
