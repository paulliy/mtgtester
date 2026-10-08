import type { AuthoringIssue } from './authoring-validation';

/** Bound authored graphs before semantic consumers recurse. Reused subtrees remain legal. */
export function validateIRGraph(value: unknown, path: string, issues: AuthoringIssue[]): boolean {
  const active = new Set<object>();
  let nodes = 0;
  function visit(entry: unknown, at: string): boolean {
    if (++nodes > 100_000) {
      issues.push({ path: at, message: 'IR graph exceeds depth or node budget' });
      return false;
    }
    if (entry === null || typeof entry !== 'object') return true;
    if (active.has(entry)) {
      issues.push({ path: at, message: 'cyclic IR graph' });
      return false;
    }
    if (active.size >= 128) {
      issues.push({ path: at, message: 'IR graph exceeds depth or node budget' });
      return false;
    }
    active.add(entry);
    for (const [key, child] of Object.entries(entry)) {
      if (!visit(child, `${at}.${key}`)) {
        active.delete(entry);
        return false;
      }
    }
    active.delete(entry);
    return true;
  }
  return visit(value, path);
}
