import { describe, expect, it } from 'vitest';
import type { LegalAction } from '@mtg/shared';
import { groupByXFamily } from './xFamilies';

function action(id: number, type = 'castSpell'): LegalAction {
  return { id, type, description: 'Cast Something' };
}

/** A family lookup standing in for the server's `xFamily` entries, keyed by action id. */
function families(
  table: Record<number, { key: string; x: number }>,
): (a: LegalAction) => { key: string; x: number } | undefined {
  return (a) => table[a.id];
}

describe('groupByXFamily', () => {
  it('collapses a family into one group sorted by X, with min, max and first', () => {
    const a = action(1);
    const b = action(2);
    const c = action(3);
    const { plain, xGroups } = groupByXFamily(
      [a, b, c],
      families({
        1: { key: 'castSpell|', x: 3 },
        2: { key: 'castSpell|', x: 1 },
        3: { key: 'castSpell|', x: 2 },
      }),
    );
    expect(plain).toEqual([]);
    expect(xGroups).toHaveLength(1);
    expect(xGroups[0]).toMatchObject({
      key: 'castSpell|',
      actions: [b, c, a],
      first: b,
      min: 1,
      max: 3,
    });
    expect(xGroups[0]?.xById.get(1)).toBe(3);
  });

  it('keeps options with no family plain and separates families by key', () => {
    const land = action(9, 'playLand');
    const { plain, xGroups } = groupByXFamily(
      [land, action(1), action(2), action(3), action(4)],
      families({
        1: { key: 'castSpell|a', x: 0 },
        2: { key: 'castSpell|a', x: 1 },
        3: { key: 'castSpell|b', x: 0 },
        4: { key: 'castSpell|b', x: 1 },
      }),
    );
    expect(plain).toEqual([land]);
    expect(xGroups.map((group) => group.key)).toEqual(['castSpell|a', 'castSpell|b']);
  });

  it('renders a family with a single affordable X as a plain button, after the other plain ones', () => {
    const only = action(1);
    const land = action(2, 'playLand');
    const { plain, xGroups } = groupByXFamily([only, land], families({ 1: { key: 'k', x: 4 } }));
    expect(xGroups).toEqual([]);
    expect(plain).toEqual([land, only]);
  });

  it('shows every option plain when the server sent no family, never guessing from the text', () => {
    const { plain, xGroups } = groupByXFamily([action(1), action(2)], () => undefined);
    expect(xGroups).toEqual([]);
    expect(plain).toHaveLength(2);
  });
});
