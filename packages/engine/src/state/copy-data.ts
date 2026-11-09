/** Copy engine data without a platform-specific cloning API; preserve aliases and array holes. */
export function copyData<T>(value: T, copies = new Map<object, unknown>()): T {
  if (typeof value === 'function') throw new Error('non-data function in engine context');
  if (value === null || typeof value !== 'object') return value;
  if (copies.has(value)) return copies.get(value) as T;
  if (Array.isArray(value)) {
    const result: unknown[] = new Array(value.length);
    copies.set(value, result);
    copyOwnEntries(value, result, copies);
    return result as T;
  }
  if (value instanceof Map) {
    const result = new Map<unknown, unknown>();
    copies.set(value, result);
    for (const [key, entry] of value) result.set(copyData(key, copies), copyData(entry, copies));
    return result as T;
  }
  if (value instanceof Set) {
    const result = new Set<unknown>();
    copies.set(value, result);
    for (const entry of value) result.add(copyData(entry, copies));
    return result as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('non-data object in engine context');
  const result: Record<string, unknown> = Object.create(prototype);
  copies.set(value, result);
  copyOwnEntries(value, result, copies);
  return result as T;
}

/**
 * Copy `source`'s own enumerable string-keyed properties onto `target` in `Object.entries` order.
 * A plain assignment makes the same writable, enumerable, configurable data property as
 * `defineProperty` does on a fresh object, without its descriptor object or the entry pairs; the
 * one key where assignment differs, `__proto__`, still goes through `defineProperty`. This runs
 * for every object of every state the mana planner copies, so the allocations mattered.
 */
function copyOwnEntries(source: object, target: object, copies: Map<object, unknown>): void {
  const from = source as Record<string, unknown>;
  const to = target as Record<string, unknown>;
  const keys = Object.keys(from);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const entry = copyData(from[key], copies);
    if (key === '__proto__')
      Object.defineProperty(to, key, {
        value: entry,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    else to[key] = entry;
  }
}
