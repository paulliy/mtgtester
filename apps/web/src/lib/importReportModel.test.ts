import type { CardReportEntry, UnmodeledCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  buildRows,
  chunk,
  countRows,
  distinctNames,
  evidenceRows,
  filterRows,
  groupOf,
  missingPiece,
  needsWork,
  parseDeckLines,
  summaryLine,
} from './importReportModel';

function entry(name: string, over: Partial<CardReportEntry> = {}): CardReportEntry {
  return {
    name,
    oracleId: name,
    typeLine: 'Artifact',
    manaCost: null,
    oracleText: '',
    oracleSha256: 'b'.repeat(64),
    status: 'implemented-unreviewed',
    unmodeledReasons: [],
    scenarios: null,
    ...over,
  };
}

describe('status groups', () => {
  it('treats unsupported and provisional as needing work', () => {
    expect(needsWork('unsupported')).toBe(true);
    expect(needsWork('provisional')).toBe(true);
    expect(needsWork('implemented-unreviewed')).toBe(false);
    expect(needsWork('implemented-reviewed')).toBe(false);
    expect(groupOf('provisional')).toBe('in-progress');
    expect(groupOf('implemented-unreviewed')).toBe('supported');
  });
});

describe('rows', () => {
  const unmodeled: UnmodeledCard[] = [
    { name: 'Mystery Engine', oracleSha256: 'c'.repeat(64), status: 'unsupported' },
  ];
  it('puts the stopped cards first, with their report when loaded', () => {
    const rows = buildRows(unmodeled, [
      entry('Forest'),
      entry('mystery engine', { status: 'unsupported', unmodeledReasons: ['reason'] }),
    ]);
    expect(rows.map((row) => row.name)).toEqual(['Mystery Engine', 'Forest']);
    expect(rows[0]?.entry?.unmodeledReasons).toEqual(['reason']);
    expect(rows[0]?.oracleSha256).toBe('c'.repeat(64));
  });
  it('keeps the preview status when no report arrived', () => {
    const rows = buildRows(unmodeled, []);
    expect(rows[0]).toMatchObject({ status: 'unsupported', entry: null });
    expect(missingPiece(rows[0]!)).toBe('Details not loaded');
  });
  it('filters and counts', () => {
    const rows = buildRows(unmodeled, [
      entry('Forest'),
      entry('Sol Ring', { status: 'provisional' }),
    ]);
    expect(filterRows(rows, 'needs-work').map((r) => r.name)).toEqual([
      'Mystery Engine',
      'Sol Ring',
    ]);
    expect(filterRows(rows, 'supported').map((r) => r.name)).toEqual(['Forest']);
    expect(filterRows(rows, 'all')).toHaveLength(3);
    expect(countRows(rows)).toEqual({ supported: 1, inProgress: 1, unsupported: 1 });
  });
  it('words the summary without claiming supported counts it does not have', () => {
    expect(summaryLine({ supported: 0, inProgress: 1, unsupported: 2 }, false)).toBe(
      "2 cards can't be played yet · 1 in progress",
    );
    expect(summaryLine({ supported: 9, inProgress: 0, unsupported: 1 }, true)).toBe(
      "1 card can't be played yet · 9 supported",
    );
  });
});

describe('evidence rows', () => {
  it('has no value where the ledger has no record, and never counts gameplay AI as done', () => {
    const none = evidenceRows({
      name: 'X',
      status: 'unsupported',
      entry: entry('X', { status: 'unsupported' }),
    });
    expect(none.map((r) => [r.key, r.value, r.done])).toEqual([
      ['implementation', 'unsupported', false],
      ['engine', null, false],
      ['viewer', null, false],
      ['gameplayAi', null, false],
    ]);
    const some = evidenceRows({
      name: 'X',
      status: 'implemented-reviewed',
      entry: entry('X', {
        status: 'implemented-reviewed',
        evidence: { engine: 'engine-tests', viewer: 'playwright', gameplayAi: 'not-evaluated' },
      }),
    });
    expect(some.map((r) => r.done)).toEqual([true, true, true, false]);
  });
  it('shows no implementation value while the card has not loaded', () => {
    expect(evidenceRows({ name: 'X', status: 'unsupported', entry: null })[0]?.value).toBeNull();
  });
});

describe('parseDeckLines', () => {
  it('reads the shapes the plaintext importer reads', () => {
    const text = [
      '// my deck',
      'Commander',
      '1 Atraxa, Praetors’ Voice',
      '',
      'Deck',
      '1x Sol Ring',
      '3 Forest (M21) 281',
      '1 Lightning Bolt *F*',
      'Commander: Kenrith, the Returned King',
      '',
      'Sideboard',
      '1 Not Counted',
    ].join('\n');
    expect(parseDeckLines(text)).toEqual([
      { name: 'Atraxa, Praetors’ Voice', qty: 1 },
      { name: 'Sol Ring', qty: 1 },
      { name: 'Forest', qty: 3 },
      { name: 'Lightning Bolt', qty: 1 },
      { name: 'Kenrith, the Returned King', qty: 1 },
    ]);
  });
  it('takes a bare name as one copy and keeps split names whole', () => {
    expect(parseDeckLines('Wear // Tear')).toEqual([{ name: 'Wear // Tear', qty: 1 }]);
    expect(distinctNames(parseDeckLines('2 Forest\n1 Forest'))).toEqual(['Forest']);
  });
});

describe('chunk', () => {
  it('splits into requests', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
