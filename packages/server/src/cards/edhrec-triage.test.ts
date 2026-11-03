import { describe, expect, it } from 'vitest';
import type { SlotFailure } from '@mtg/engine';
import {
  primaryFailure,
  renderTriageJson,
  renderTriageMarkdown,
  textShape,
  triageRecord,
} from './edhrec-triage';

const CHORD =
  'Search your library for a creature card with mana value X or less, put it onto the battlefield, then shuffle.';

describe('primaryFailure', () => {
  it('drops whole-line cost and trigger readings the classifier abandoned', () => {
    const line = 'Destroy target land.';
    const failures: SlotFailure[] = [
      { slot: 'cost', text: 'destroy target land' },
      { slot: 'trigger event', text: 'destroy target land.' },
      { slot: 'effect', text: 'Destroy target land' },
    ];
    expect(primaryFailure(line, failures)).toEqual({ slot: 'effect', text: 'Destroy target land' });
  });

  it('keeps a whole-line trigger failure when the line is a trigger', () => {
    const line = 'Whenever you cycle this card, draw a card.';
    const failure: SlotFailure = { slot: 'trigger event', text: line.toLowerCase() };
    expect(primaryFailure(line, [failure])).toBe(failure);
  });

  it('prefers the shortest phrase-slot failure over effect failures', () => {
    const failures: SlotFailure[] = [
      { slot: 'subject', text: 'creature card with mana value x' },
      { slot: 'card filter', text: 'a creature card with mana value x or less' },
      { slot: 'effect', text: 'shuffle' },
      { slot: 'effect', text: CHORD.slice(0, -1) },
    ];
    expect(primaryFailure(CHORD, failures)?.slot).toBe('subject');
  });

  it('picks the earliest effect fragment, not the ", then" tail', () => {
    const line =
      'Its controller may search their library for a basic land card, put it onto the battlefield tapped, then shuffle.';
    const head: SlotFailure = {
      slot: 'effect',
      text: 'its controller may search their library for a basic land card, put it onto the battlefield tapped',
    };
    const failures: SlotFailure[] = [head, { slot: 'effect', text: 'shuffle' }];
    expect(primaryFailure(line, failures)).toBe(head);
  });

  it('ignores failures on text outside the line and returns null when nothing is left', () => {
    expect(primaryFailure('Draw a card.', [{ slot: 'subject', text: 'elves you control' }])).toBe(
      null,
    );
  });
});

describe('triageRecord', () => {
  it('reports the primary slot, the other slots that failed, and line when nothing did', () => {
    const record = triageRecord({
      rank: 7,
      name: 'Probe',
      decks: 10,
      line: 'When this creature enters, if you attacked this turn, draw cards equal to its power.',
      failures: [
        { slot: 'condition', text: 'you attacked this turn' },
        { slot: 'effect', text: 'draw cards equal to its power' },
      ],
    });
    expect(record).toMatchObject({
      slot: 'condition',
      text: 'you attacked this turn',
      alsoFailed: ['effect'],
    });
    const bare = triageRecord({ rank: 8, name: 'Bare', decks: 1, line: 'Storm', failures: [] });
    expect(bare).toMatchObject({ slot: 'line', text: 'Storm', alsoFailed: [] });
  });
});

describe('rendering', () => {
  const records = [
    triageRecord({ rank: 9, name: 'B', decks: 30, line: 'Toxic 2', failures: [] }),
    triageRecord({ rank: 3, name: 'A', decks: 70, line: 'Toxic 1', failures: [] }),
  ];

  it('writes JSON one row per line in rank order', () => {
    const lines = renderTriageJson(records).trimEnd().split('\n');
    expect(lines[0]).toBe('[');
    expect(JSON.parse(lines[1]!.replace(/,$/, '')).rank).toBe(3);
    expect(JSON.parse(lines[2]!).rank).toBe(9);
  });

  it('groups failing texts by shape in the summary', () => {
    expect(textShape('Toxic 2')).toBe('toxic n');
    expect(textShape('Add {R}{R}. Create a 2/2 token with +1/+1')).toBe(
      'add {m}{m}. create a p/t token with +n/+n',
    );
    const markdown = renderTriageMarkdown({ records, totalSlots: 1000, source: 'test' });
    expect(markdown).toContain('| line | 2 | 10.00% |');
    expect(markdown).toContain('- 2 × `toxic n` (A, B)');
  });
});
