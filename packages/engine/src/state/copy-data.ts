/** Copy engine data without a platform-specific cloning API; preserve aliases and array holes. */
export function copyData<T>(value: T, copies = new Map<object, unknown>()): T {
  if (typeof value === 'function') throw new Error('non-data function in engine context');
  if (value === null || typeof value !== 'object') return value;
  if (copies.has(value)) return copies.get(value) as T;
  if (Array.isArray(value)) {
    const result: unknown[] = new Array(value.length);
    copies.set(value, result);
    for (const [key, entry] of Object.entries(value))
      Object.defineProperty(result, key, {
        value: copyData(entry, copies),
        writable: true,
        enumerable: true,
        configurable: true,
      });
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
  for (const [key, entry] of Object.entries(value))
    Object.defineProperty(result, key, {
      value: copyData(entry, copies),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  return result as T;
}
