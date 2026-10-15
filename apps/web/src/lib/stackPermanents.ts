import type { SpectatorPermanent } from '@mtg/shared';

export interface GroupedPermanent {
  permanent: SpectatorPermanent;
  count: number;
}

/**
 * Identity for stacking: two permanents collapse into one tile only when nothing a reader could
 * act on differs. P/T is in the key because a pumped copy is not the same board object as an
 * unpumped one — grouping on name alone hid that.
 */
export function stackKey(p: SpectatorPermanent): string {
  const counters = Object.keys(p.counters)
    .sort()
    .map((kind) => `${kind}:${p.counters[kind] ?? 0}`)
    .join(',');
  return [
    p.name,
    p.scryfallId ?? 'null',
    p.tapped ? 'tapped' : 'untapped',
    p.summoningSick ? 'sick' : 'ready',
    p.attacking ?? 'none',
    p.attackingPlaneswalker ?? 'none',
    p.blocking ?? 'none',
    p.damageMarked,
    p.power ?? '-',
    p.toughness ?? '-',
    counters,
    [...p.keywords].sort().join(','),
  ].join('|');
}

export function groupPermanents(perms: SpectatorPermanent[]): GroupedPermanent[] {
  // A Map, not a linear scan that rebuilt every candidate's key on every comparison: a wide
  // board made drawing one seat quadratic in its permanent count, on every state push.
  const groups = new Map<string, GroupedPermanent>();
  for (const perm of perms) {
    const key = stackKey(perm);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { permanent: perm, count: 1 });
    else existing.count++;
  }
  return [...groups.values()];
}
