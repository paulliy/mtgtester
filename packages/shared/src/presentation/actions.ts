import type { LegalAction } from '../engine';
import { actionLabel, manaSymbols } from './labels';

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
  if (action.type === 'activateManaAbility') {
    const name = typeof source === 'string' ? source : 'mana source';
    return `Tap ${name} for ${
      manaSymbols(action)
        .map((symbol) => `{${symbol}}`)
        .join('') || 'mana'
    }`;
  }
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

/** The ids of the permanents the engine's auto-payment would tap. */
export function paymentSourceIds(action: LegalAction): string[] {
  const ids = actionData(action, 'paymentSourceIds');
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** "Forest ×2, Sol Ring" — repeated sources counted rather than listed again. */
export function paymentSourceSummary(action: LegalAction): string {
  const counts = new Map<string, number>();
  for (const name of paymentSourceNames(action)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
}

/**
 * A {X} spell/ability offers one whole `LegalAction` per affordable X (brief: "the option menu
 * is the contract" — `legal.ts` enumerates every value up front so nothing needs a second
 * legality check). Rendered flat that's one button per value — up to however much mana the
 * player has, sometimes dozens. The family key says which options differ only in X (same type,
 * same mode); a client collapses each family into a single numeric input, and picking a number
 * just looks up the matching pre-enumerated action, so legality is still exactly what the
 * engine offered.
 */
export function xFamily(action: LegalAction): { key: string; x: number } | null {
  const x = actionData(action, 'x');
  if (typeof x !== 'number') return null;
  const modeLabel = actionData(action, 'modeLabel');
  return { key: `${action.type}|${typeof modeLabel === 'string' ? modeLabel : ''}`, x };
}
