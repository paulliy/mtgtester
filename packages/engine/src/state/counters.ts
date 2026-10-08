/** Counter names are data keys; inherited object properties are never counters. */
export function counterCount(counters: Readonly<Record<string, number>>, name: string): number {
  return Object.hasOwn(counters, name) ? counters[name]! : 0;
}

/** Define an owned numeric value even for names such as __proto__. */
export function setCounterCount(
  counters: Record<string, number>,
  name: string,
  count: number,
): void {
  Object.defineProperty(counters, name, {
    value: count,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
