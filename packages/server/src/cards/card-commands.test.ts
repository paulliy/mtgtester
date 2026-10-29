/** The authoring commands' pure parts (ADR 0033 decision 1, plan phase 2). */
import { describe, expect, it } from 'vitest';
import { lineDiff, snapshotChange } from '../../../../scripts/cards/card-check';

describe('card:check', () => {
  it('diffs two texts line by line', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual(['- b', '+ x']);
    expect(lineDiff('a\nb', 'a\nb')).toEqual([]);
    expect(lineDiff('', 'a')).toEqual(['- ', '+ a']);
  });

  it("reports one card's override snapshot change, and nothing for other cards", () => {
    const entry = (id: string, op: string) => ({
      oracleId: id,
      name: id,
      handledLines: [],
      def: { op },
    });
    const baseline = JSON.stringify([entry('a', 'draw'), entry('b', 'gain')]);
    const current = JSON.stringify([entry('a', 'draw'), entry('b', 'lose')]);
    expect(snapshotChange(baseline, current, 'a')).toEqual([]);
    expect(snapshotChange(baseline, current, 'b')).toEqual([
      expect.stringMatching(/^- .*"op": "gain"/),
      expect.stringMatching(/^\+ .*"op": "lose"/),
    ]);
    expect(snapshotChange(baseline, current, 'z')).toBeNull();
  });
});
