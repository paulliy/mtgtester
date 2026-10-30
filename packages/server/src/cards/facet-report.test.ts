/** ADR 0034 decision 6: facet warnings, and a manifest note in place of a known one. */
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../../../engine/src/cards/definition';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { oracle } from '../../../engine/tests/fixtures';
import { facetNotes, facetReport } from '../../../../scripts/cards/facet-report';

const card = oracle({
  name: 'Facet Probe',
  typeLine: 'Instant',
  oracleText: 'Target creature gets +2/+2 until end of turn.',
});
const definition = {
  ...interpretCard(card),
  spellAbility: { kind: 'spell', targets: [], effects: [] },
} as unknown as CardDefinition;

describe('facet report', () => {
  it('warns on each facet the IR does not state, and shows a note instead where one is kept', () => {
    expect(facetReport(card, definition, [])).toEqual([
      'warning: untilEndOfTurn: the text says 1, the IR has 0',
      'warning: targetCount: the text says 1, the IR has 0',
    ]);
    expect(
      facetReport(card, definition, [{ facet: 'targetCount', reason: 'a stand-in definition' }]),
    ).toEqual([
      'warning: untilEndOfTurn: the text says 1, the IR has 0',
      'noted: targetCount (the text says 1, the IR has 0): a stand-in definition',
    ]);
    expect(facetReport(card, interpretCard(card), [])).toEqual([]);
  });

  it("reads a card's notes from its manifest entry", () => {
    const manifest = JSON.stringify({
      cards: { id: { name: 'Facet Probe', facetNotes: [{ facet: 'optional', reason: 'r' }] } },
    });
    expect(facetNotes(manifest, 'Facet Probe')).toEqual([{ facet: 'optional', reason: 'r' }]);
    expect(facetNotes(manifest, 'Other Card')).toEqual([]);
  });
});
