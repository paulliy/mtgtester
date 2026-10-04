const LIMIT = 5;

export function pruneRecentIds(ids: readonly string[], available: readonly string[]): string[] {
  const live = new Set(available);
  return [...new Set(ids.filter((id) => live.has(id)))].slice(0, LIMIT);
}

export function pushRecentId(ids: readonly string[], id: string): string[] {
  return [id, ...ids.filter((old) => old !== id)].slice(0, LIMIT);
}

export function readRecentIds(key: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string').slice(0, LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function saveRecentIds(key: string, ids: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids.slice(0, LIMIT)));
  } catch {
    // Recent setup history is optional metadata; a storage failure must not stop a game start.
  }
}

/**
 * Reconcile stored deck recents with what a server can actually offer, then persist only when the
 * answer is authoritative. A server without a database reports `enabled: false` and an empty deck
 * list; that means "cannot say", not "none exist", so visiting it must leave a saved-deck history
 * untouched instead of pruning it to nothing.
 */
export function syncRecentDeckIds(
  key: string,
  ids: readonly string[],
  source: { enabled: boolean; available: readonly string[] },
): string[] {
  if (!source.enabled) return [...ids];
  const pruned = pruneRecentIds(ids, source.available);
  saveRecentIds(key, pruned);
  return pruned;
}
