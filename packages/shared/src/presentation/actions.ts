import type { LegalAction } from '../engine';
import { actionLabel } from './labels';

/** One entry of an action's free-form `data` bag. */
export function actionData(action: LegalAction, key: string): unknown {
  return action.data?.[key];
}

/** The cost chips on an action: its mana cost, then each non-mana ability cost. */
export function actionCost(action: LegalAction): string[] {
  const mana = actionData(action, 'manaCost');
  const costs = actionData(action, 'abilityCosts');
  const labels: string[] = [];
  if (typeof mana === 'string') labels.push(mana);
  if (Array.isArray(costs)) {
    for (const cost of costs) {
      if (typeof cost !== 'object' || cost === null) continue;
      const value = cost as {
        kind?: unknown;
        amount?: unknown;
        counter?: unknown;
        count?: unknown;
      };
      if (value.kind === 'tap') labels.push('Tap this');
      if (value.kind === 'sacrificeSelf') labels.push('Sacrifice this');
      if (value.kind === 'payLife' && typeof value.amount === 'number')
        labels.push(`Pay ${value.amount} life`);
      if (
        value.kind === 'removeCounters' &&
        typeof value.counter === 'string' &&
        typeof value.count === 'number'
      ) {
        labels.push(
          `Remove ${value.count} ${value.counter} counter${value.count === 1 ? '' : 's'}`,
        );
      }
      if (
        value.kind === 'removeCountersFromAmong' &&
        typeof value.counter === 'string' &&
        typeof value.count === 'number'
      ) {
        labels.push(
          `Remove ${value.count} ${value.counter} counter${value.count === 1 ? '' : 's'} from a permanent you control`,
        );
      }
    }
  }
  return labels;
}

/** The one-line "what you are about to do" heading for a selected action. */
export function pendingSummary(action: LegalAction): string {
  const source = actionData(action, 'sourceName');
  const label = typeof source === 'string' ? source : actionLabel(action);
  if (action.type === 'playLand') return `Play ${label}`;
  if (action.type === 'castSpell') return `Cast ${label}`;
  if (action.type === 'activateAbility') return `Activate ${label}`;
  return action.description;
}

export function paymentSourceNames(action: LegalAction): string[] {
  const names = actionData(action, 'paymentSourceNames');
  return Array.isArray(names) && names.every((name) => typeof name === 'string')
    ? (names as string[])
    : [];
}

/** "Forest ×2, Sol Ring" — repeated sources counted rather than listed again. */
export function paymentSourceSummary(action: LegalAction): string {
  const counts = new Map<string, number>();
  for (const name of paymentSourceNames(action)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
}

export interface XActionGroup {
  key: string;
  actions: LegalAction[];
  /** Same as `actions[0]`/`actions[actions.length - 1]` — stored so callers never index an
   * array TS can't prove is non-empty. */
  first: LegalAction;
  min: number;
  max: number;
}

/**
 * A {X} spell/ability offers one whole `LegalAction` per affordable X (brief: "the option menu
 * is the contract" — `legal.ts` enumerates every value up front so nothing needs a second
 * legality check). Rendered flat that's one button per value — up to however much mana the
 * player has, sometimes dozens. Collapsed here into a single numeric-input row per X-family
 * (same source, same mode); picking a number just looks up the matching pre-enumerated action,
 * so legality is still exactly what the engine offered, nothing computed client-side.
 */
export function groupXActions(actions: readonly LegalAction[]): {
  plain: LegalAction[];
  xGroups: XActionGroup[];
} {
  const plain: LegalAction[] = [];
  const byKey = new Map<string, LegalAction[]>();
  for (const action of actions) {
    const x = actionData(action, 'x');
    if (typeof x !== 'number') {
      plain.push(action);
      continue;
    }
    const modeLabel = actionData(action, 'modeLabel');
    const key = `${action.type}|${typeof modeLabel === 'string' ? modeLabel : ''}`;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [action]);
    else list.push(action);
  }
  const xGroups: XActionGroup[] = [];
  for (const [key, group] of byKey) {
    // Only one affordable X value: no real choice to make, render it like any other button.
    if (group.length < 2) {
      plain.push(...group);
      continue;
    }
    const sorted = [...group].sort(
      (a, b) => (actionData(a, 'x') as number) - (actionData(b, 'x') as number),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first === undefined || last === undefined) continue; // unreachable: length >= 2
    xGroups.push({
      key,
      actions: sorted,
      first,
      min: actionData(first, 'x') as number,
      max: actionData(last, 'x') as number,
    });
  }
  return { plain, xGroups };
}
