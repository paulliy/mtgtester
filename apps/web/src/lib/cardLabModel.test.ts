import { describe, expect, it } from 'vitest';
import type { CardTestScenarioMetadata } from '@mtg/shared';
import {
  cardNameFromTitles,
  filterCards,
  groupScenariosByCard,
  parseQueue,
  startQueue,
  titleSubject,
} from './cardLabModel';

function scenario(
  id: string,
  title: string,
  oracleSha256: string,
  clauseIds: string[],
): CardTestScenarioMetadata {
  return {
    id,
    version: 1,
    title,
    instructions: [],
    expectedOutcome: '',
    oracleSha256,
    clauseIds,
  };
}

const CATALOG = [
  scenario('b-1', 'Bolt: deals 3', 'sha-b', ['bolt-clause-1']),
  scenario('a-1', 'Aberrant: X=5', 'sha-a', ['aberrant-clause-1']),
  scenario('b-2', 'Bolt: kills a bear', 'sha-b', ['bolt-clause-1', 'bolt-clause-2']),
  scenario('b-3', 'Bolt overloaded: hits all', 'sha-b', ['bolt-clause-2']),
];

describe('card lab model', () => {
  it('names a card from the title before the first colon', () => {
    expect(titleSubject('Bolt: deals 3: really')).toBe('Bolt');
    expect(titleSubject('No colon here')).toBe('No colon here');
    expect(cardNameFromTitles(['Bolt: a', 'Bolt overloaded: b', 'Bolt: c'])).toBe('Bolt');
    expect(cardNameFromTitles(['Bolt: a', 'Other: b'])).toBe('Bolt');
  });

  it('groups by Oracle pin, sorts by name and maps clauses to their scenarios', () => {
    const cards = groupScenariosByCard(CATALOG);
    expect(cards.map((card) => card.name)).toEqual(['Aberrant', 'Bolt']);
    const bolt = cards[1]!;
    expect(bolt.scenarios.map((entry) => entry.id)).toEqual(['b-1', 'b-2', 'b-3']);
    expect(bolt.clauses.map((clause) => [clause.id, clause.scenarios.map((s) => s.id)])).toEqual([
      ['bolt-clause-1', ['b-1', 'b-2']],
      ['bolt-clause-2', ['b-2', 'b-3']],
    ]);
  });

  it('filters by name and keeps every card for an empty query', () => {
    const cards = groupScenariosByCard(CATALOG);
    expect(filterCards(cards, '  BOL ').map((card) => card.name)).toEqual(['Bolt']);
    expect(filterCards(cards, '')).toHaveLength(2);
    expect(filterCards(cards, 'zzz')).toEqual([]);
  });

  it('builds a queue of the card scenarios and rejects a malformed stored one', () => {
    const bolt = groupScenariosByCard(CATALOG)[1]!;
    const queue = startQueue(bolt);
    expect(queue).toEqual({ oracleSha256: 'sha-b', remaining: ['b-1', 'b-2', 'b-3'], total: 3 });
    expect(parseQueue(JSON.stringify(queue))).toEqual(queue);
    expect(parseQueue(null)).toBeNull();
    expect(parseQueue('{')).toBeNull();
    expect(parseQueue('{"oracleSha256":1}')).toBeNull();
  });
});
