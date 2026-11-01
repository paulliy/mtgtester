import type { LegalAction } from './protocol';

export interface XActionGroup {
  /** The server's family key: options that share it differ only in X. */
  key: string;
  /** Every option of the family, sorted by X. */
  actions: LegalAction[];
  /** `actions[0]`, stored so callers never index an array TS can't prove is non-empty. */
  first: LegalAction;
  min: number;
  max: number;
  /** The X each action announces, by action id. */
  xById: ReadonlyMap<number, number>;
}

/**
 * A {X} spell/ability offers one whole `LegalAction` per affordable X, up to dozens. Rendered flat
 * that is one button per value, so the options of one family (the server's `xFamily` key) collapse
 * into a single numeric-input row. Picking a number just looks up the matching pre-enumerated
 * action, so legality is still exactly what the engine offered. This is layout only: which
 * options belong together, and each one's X, arrive from the server.
 */
export function groupByXFamily(
  actions: readonly LegalAction[],
  familyOf: (action: LegalAction) => { key: string; x: number } | undefined,
): { plain: LegalAction[]; xGroups: XActionGroup[] } {
  const plain: LegalAction[] = [];
  const byKey = new Map<string, Array<{ action: LegalAction; x: number }>>();
  for (const action of actions) {
    const family = familyOf(action);
    if (family === undefined) {
      plain.push(action);
      continue;
    }
    const list = byKey.get(family.key);
    if (list === undefined) byKey.set(family.key, [{ action, x: family.x }]);
    else list.push({ action, x: family.x });
  }
  const xGroups: XActionGroup[] = [];
  for (const [key, group] of byKey) {
    // Only one affordable X value: no real choice to make, render it like any other button.
    if (group.length < 2) {
      plain.push(...group.map((member) => member.action));
      continue;
    }
    const sorted = [...group].sort((a, b) => a.x - b.x);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first === undefined || last === undefined) continue; // unreachable: length >= 2
    xGroups.push({
      key,
      actions: sorted.map((member) => member.action),
      first: first.action,
      min: first.x,
      max: last.x,
      xById: new Map(sorted.map((member) => [member.action.id, member.x])),
    });
  }
  return { plain, xGroups };
}
