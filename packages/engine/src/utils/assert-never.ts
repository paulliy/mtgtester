/** Exhaustive IR dispatch. Unknown runtime variants fail closed as well. */
export function assertNever(value: never, context = 'unhandled variant'): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}
