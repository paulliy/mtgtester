/**
 * Guards the coverage classifier. The CLI is the instrument that produces the number; these
 * tests guard the thing that turns reason strings into a work backlog, because a
 * mis-classification silently mis-ranks what gets built next.
 *
 * Deliberately asserts no coverage percentage — that moves with every parser change, and
 * pinning it here would make honest progress look like a test failure.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { classifyReason, measureCoverage } from './coverage';

const unrecognized = (text: string): string => `unrecognized rules text: "${text}"`;

function card(partial: Partial<OracleCard> & { name: string }): OracleCard {
  return {
    oracleId: `oracle-${partial.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    scryfallId: `scry-${partial.name}`,
    manaCost: '{1}',
    cmc: 1,
    colors: [],
    colorIdentity: [],
    typeLine: 'Creature — Test',
    supertypes: [],
    types: ['Creature'],
    subtypes: ['Test'],
    oracleText: '',
    power: '2',
    toughness: '2',
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
    ...partial,
  };
}

describe('classifyReason', () => {
  it('maps structured reasons to their family', () => {
    expect(classifyReason('unsupported mana cost symbols: {X}')).toEqual(['unsupported mana cost']);
    expect(classifyReason('unsupported layout "modal_dfc"')).toEqual(['unsupported layout']);
    expect(classifyReason('unsupported card type "Conspiracy"')).toEqual(['unsupported card type']);
    expect(classifyReason('non-numeric power/toughness "*"')).toEqual([
      'non-numeric characteristic',
    ]);
  });

  it('classifies a cost-then-colon line as an activated ability', () => {
    expect(classifyReason(unrecognized('{2}{B}, {T}: Draw a card.'))).toContain(
      'activated ability (non-mana)',
    );
  });

  it('does NOT call a plain tap-for-mana line an activated ability', () => {
    // It has the `cost: effect` shape, but needs no cost machinery — counting it here would
    // inflate the single family the build order is keyed on.
    const families = classifyReason(unrecognized('{T}: Add {R} or {G}.'));
    expect(families).not.toContain('activated ability (non-mana)');
    expect(families).toContain('choice-of-color mana');
  });

  it('still calls a COSTED mana ability an activated ability', () => {
    const families = classifyReason(
      unrecognized('{T}, Tap an untapped creature you control: Add one mana of any color.'),
    );
    expect(families).toContain('activated ability (non-mana)');
  });

  it('is non-exclusive — one line can implicate several mechanics', () => {
    const families = classifyReason(
      unrecognized('{T}, Sacrifice this creature: Create a 1/1 white Soldier creature token.'),
    );
    expect(families).toEqual(
      expect.arrayContaining(['activated ability (non-mana)', 'sacrifice outlet', 'token creation']),
    );
  });

  it('separates a parameterized keyword from a bare one', () => {
    expect(classifyReason(unrecognized('Cycling {2}'))).toEqual(['keyword with cost']);
    expect(classifyReason(unrecognized('Crew 2'))).toEqual(['keyword with cost']);
    expect(classifyReason(unrecognized('Convoke'))).toEqual(['unimplemented keyword']);
    expect(classifyReason(unrecognized('flying, vigilance'))).toEqual(['unimplemented keyword']);
  });

  it('recognizes an ability-word prefix', () => {
    expect(
      classifyReason(unrecognized('Metalcraft — If you control three or more artifacts, draw a card.')),
    ).toContain('ability word prefix');
  });

  it('recognizes aura statics', () => {
    expect(classifyReason(unrecognized('Enchant creature'))).toContain('aura statics');
    expect(classifyReason(unrecognized('Enchanted creature gets +1/+1.'))).toContain('aura statics');
  });

  it('falls back to "other" rather than guessing', () => {
    expect(classifyReason(unrecognized('Whenever a Zubera you control dies, scry 4.'))).toEqual([
      'other',
    ]);
    expect(classifyReason('some reason shape that does not exist yet')).toEqual(['other']);
  });
});

describe('measureCoverage', () => {
  const vanilla = card({ name: 'Vanilla Bear' });
  // Two lines the interpreter still cannot read, from two different families — the point of the
  // attribution test. ("{2}{U}, {T}: Draw a card." used to belong here and no longer does: the
  // engine reads simple activated abilities as of ADR 0010 increment 5.)
  const complex = card({
    name: 'Busy Wizard',
    oracleText: '{2}{U}, {T}: Target player mills four cards.\nEcho {2}',
  });

  it('counts unique cards and modeled cards across decks', () => {
    const report = measureCoverage([
      { name: 'A', cards: [vanilla, complex] },
      { name: 'B', cards: [vanilla] },
    ]);

    expect(report.uniqueCards).toBe(2);
    expect(report.modeledCards).toBe(1);
    expect(report.decks).toEqual([
      { name: 'A', uniqueCards: 2, modeled: 1 },
      { name: 'B', uniqueCards: 1, modeled: 1 },
    ]);
  });

  it('de-duplicates a card by oracleId and records every deck it appeared in', () => {
    const report = measureCoverage([
      { name: 'A', cards: [vanilla, vanilla] },
      { name: 'B', cards: [vanilla] },
    ]);

    expect(report.uniqueCards).toBe(1);
    expect(report.cards[0]?.deckNames).toEqual(['A', 'B']);
  });

  it('attributes an unmodeled card to every family blocking it', () => {
    const report = measureCoverage([{ name: 'A', cards: [complex] }]);
    const entry = report.cards.find((c) => c.name === 'Busy Wizard');

    expect(entry?.modeled).toBe(false);
    expect(entry?.families).toEqual(
      expect.arrayContaining(['activated ability (non-mana)', 'keyword with cost']),
    );
  });

  it('reports a modeled card with no reasons and no families', () => {
    const report = measureCoverage([{ name: 'A', cards: [vanilla] }]);
    expect(report.cards[0]).toMatchObject({ modeled: true, reasons: [], families: [] });
  });

  it('ranks families by how many cards they block, descending', () => {
    const report = measureCoverage([{ name: 'A', cards: [complex] }]);
    const counts = report.byFamily.map((f) => f.cards);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});
