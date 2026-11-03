/**
 * Slot diagnostics (ADR 0038 decision 2): which grammar slot failed inside an unparsed line,
 * collected only on request and never changing what `interpretCard` returns.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard, interpretCardWithDiagnostics } from '../src/cards/interpret';
import { collectSlotDiagnostics, noteSlotFailure } from '../src/cards/grammar/diagnostics';
import { supportCard } from '../src/testing/card-scenario';

function creature(oracleText: string): OracleCard {
  return supportCard({
    name: 'Diagnostic Probe',
    typeLine: 'Creature — Human',
    manaCost: '{2}{G}',
    power: '2',
    toughness: '2',
    oracleText,
  });
}

describe('slot diagnostics', () => {
  it('names the trigger event when the head is unknown', () => {
    const { definition, failures } = interpretCardWithDiagnostics(
      creature('Whenever you cycle this card, draw a card.'),
    );
    expect(definition.modeled).toBe(false);
    expect(failures).toContainEqual({
      slot: 'trigger event',
      text: 'whenever you cycle this card, draw a card.',
    });
  });

  it('names the condition when only the intervening-if is unknown', () => {
    const { failures } = interpretCardWithDiagnostics(
      creature('When this creature enters, if you attacked this turn, draw a card.'),
    );
    expect(failures).toContainEqual({ slot: 'condition', text: 'you attacked this turn' });
    expect(failures.some((failure) => failure.slot === 'trigger event')).toBe(false);
  });

  it('names the effect sentence when the head parses and the body does not', () => {
    const { failures } = interpretCardWithDiagnostics(
      creature('{3}{U}: Each player draws a card.'),
    );
    expect(failures).toContainEqual({ slot: 'effect', text: 'each player draws a card' });
  });

  it('returns exactly the definition interpretCard returns', () => {
    for (const text of [
      'When this creature enters, draw a card.',
      'Whenever you cycle this card, draw a card.',
      'Flying\n{T}: Add {G}.',
    ]) {
      const card = creature(text);
      expect(interpretCardWithDiagnostics(card).definition).toEqual(interpretCard(card));
    }
  });

  it('records nothing outside a collection and restores an outer collection', () => {
    noteSlotFailure('amount', 'outside any collection');
    const outer = collectSlotDiagnostics(() => {
      noteSlotFailure('amount', 'outer');
      const inner = collectSlotDiagnostics(() => noteSlotFailure('subject', 'inner'));
      noteSlotFailure('cost', 'outer again');
      return inner.failures;
    });
    expect(outer.result).toEqual([{ slot: 'subject', text: 'inner' }]);
    expect(outer.failures).toEqual([
      { slot: 'amount', text: 'outer' },
      { slot: 'cost', text: 'outer again' },
    ]);
  });
});
