import { describe, expect, it } from 'vitest';
import type { CardTestLabCard, CardTestScenarioMetadata } from '@mtg/shared';
import {
  cardNameFromTitles,
  evidenceRows,
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

describe('card lab evidence', () => {
  const base: CardTestLabCard = {
    oracleSha256: 'a'.repeat(64),
    manifestPinned: true,
    clauses: [
      {
        id: 'c1',
        oracleText: 'Flying',
        implementation: [],
        engineTestIds: ['t'],
        viewerScenarioIds: [],
        scenarioIds: ['s1'],
      },
    ],
    unmappedScenarioIds: [],
    gameplayAiScenarioIds: [],
    audit: 'absent',
  };
  const row = (rows: ReturnType<typeof evidenceRows>, label: string) =>
    rows.find((entry) => entry.label === label)!;

  it('names real names from the report and falls back to the title', () => {
    const group = [
      scenario('s1', 'Title Name: one', 'h1', []),
      scenario('s2', 'Other: two', 'h2', []),
    ];
    const cards = groupScenariosByCard(group, new Map([['h1', 'Real Name']]));
    expect(cards.map((card) => card.name)).toEqual(['Other', 'Real Name']);
  });

  it('records nothing the manifest and ledger do not hold', () => {
    const rows = evidenceRows(base.oracleSha256, 1, undefined);
    expect(rows.filter((entry) => entry.recorded).map((entry) => entry.label)).toEqual([
      'Pinned Oracle text',
    ]);
    const absent = evidenceRows(base.oracleSha256, 1, base);
    expect(row(absent, 'Every clause mapped to scenarios').recorded).toBe(true);
    for (const label of [
      'Engine evidence',
      'Seen working in the real viewer',
      'Gameplay AI uses it sensibly',
    ]) {
      expect(row(absent, label).recorded).toBe(false);
      expect(row(absent, label).state).toMatch(/^Not recorded/);
    }
  });

  it('reports a clause gap and does not call a stale ledger evidence', () => {
    const gap: CardTestLabCard = {
      ...base,
      audit: 'stale',
      clauses: [...base.clauses, { ...base.clauses[0]!, id: 'c2', scenarioIds: [] }],
    };
    const rows = evidenceRows(gap.oracleSha256, 1, gap);
    expect(row(rows, 'Every clause mapped to scenarios')).toMatchObject({
      recorded: false,
      state: expect.stringContaining('1 of 2 clauses have no scenario'),
    });
    expect(row(rows, 'Engine evidence').state).toMatch(/different Oracle text/);
  });

  it('shows the ledger values, recording only the ones that are evidence', () => {
    const rows = evidenceRows(base.oracleSha256, 1, {
      ...base,
      audit: 'current',
      ledger: {
        engine: 'engine-tests',
        viewer: 'not-run',
        gameplayAi: 'not-evaluated',
        engineTestIds: ['a'],
        note: 'n',
      },
    });
    expect(row(rows, 'Engine evidence')).toMatchObject({
      recorded: true,
      state: 'Ledger: engine tests',
      detail: 'Tests: a',
    });
    expect(row(rows, 'Seen working in the real viewer')).toMatchObject({
      recorded: false,
      state: 'Ledger: not run',
    });
    expect(row(rows, 'Gameplay AI uses it sensibly').recorded).toBe(false);
    expect(row(rows, 'Ledger note')).toMatchObject({ state: 'n', recorded: false, info: true });
  });
});
