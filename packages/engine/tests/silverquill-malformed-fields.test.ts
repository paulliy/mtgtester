/**
 * Six cards in `silverquill-influence-remaining.ts` carried fields that were not part of the IR
 * at all. They never typechecked — the file's registration wrapper took `def: any`, so the
 * checker never looked. Each one silently did nothing at runtime, which is the specific failure
 * mode the ability IR is prone to: `resolve.ts` skips an effect it cannot resolve rather than
 * throwing, so a malformed card looks like a card that simply never triggers.
 *
 * These assert the corrected shapes. They are deliberately structural rather than full-game:
 * what was broken was the authored data, and the executor paths they feed are already covered by
 * `layers.test.ts`, `enters-tapped.test.ts` and `activated.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { getOverride } from '../src/cards/overrides';
import { constant } from '../src/cards/value';

const defOf = (oracleId: string) => getOverride(oracleId)?.def;

describe('Darksteel Mutation', () => {
  it('sets base power/toughness with a Value, not a bare number', () => {
    // Layer 7b takes a `Value`. A bare `0` has no `kind`, so the layer pass could not read the
    // base P/T this Aura exists entirely to set.
    const pt = defOf('05a4f8ff-49da-42af-add5-6248c4b0644b')?.staticEffects?.find(
      (s) => 'sublayer' in s.op && s.op.sublayer === 'b',
    );
    expect(pt?.op).toEqual({ layer: 7, sublayer: 'b', power: constant(0), toughness: constant(1) });
  });
});

describe('Fallen Ideal', () => {
  it('has no override left: the interpreter grants the sacrifice ability to the enchanted creature', () => {
    // Restored in coverage PR05; its behavior is covered in pr05-card-coverage.test.ts.
    expect(getOverride('4b8183e6-4ff2-4254-9ee0-0ebbf8cef4a3')).toBeUndefined();
  });
});

describe('Shineshadow Snarl', () => {
  it('names the land subtypes it lets you reveal', () => {
    // The condition field is `subtypes: string[]`; a `filter` Selector was ignored, so the reveal
    // never succeeded and the land always entered tapped.
    expect(defOf('c9fc13d6-bd10-47bc-b2b6-7f67a1f3371e')?.entersTappedUnless).toEqual({
      kind: 'mayRevealCardFromHand',
      subtypes: ['Plains', 'Swamp'],
    });
  });
});

describe('Starfield Mystic', () => {
  it('places its counter through `count`, the field putCounters actually reads', () => {
    const effect = defOf('2975590d-6a5b-41e5-8a3b-e9325e71226a')?.triggers?.[0]?.effects[0];
    expect(effect).toEqual({
      op: 'putCounters',
      counter: '+1/+1',
      count: constant(1),
      target: 'source',
    });
  });
});

describe('Study Hall', () => {
  it('authors the mana-costed ability with its commander spend trigger', () => {
    const abilities = defOf('eb735501-19e7-4910-aa6a-6667fff6f4e5')?.manaAbilities ?? [];
    expect(abilities).toHaveLength(2);
    expect(abilities[1]?.costs?.map((cost) => cost.kind)).toEqual(['mana', 'tap']);
    expect(abilities[1]?.spendTrigger?.ability.effects).toEqual([
      { op: 'scry', count: { kind: 'commanderCastCount', player: 'you' } },
    ]);
  });
});

describe("Sentinel's Eyes", () => {
  it('has no stale hand-authored override after Escape became generic', () => {
    expect(defOf('0a7d6489-b239-4ce8-aea3-7b5d0e436f70')).toBeUndefined();
  });
});
