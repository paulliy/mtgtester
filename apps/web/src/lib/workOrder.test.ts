import type { CardReportEntry } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import type { ReportRow } from './importReportModel';
import { workOrderFileName, workOrderMarkdown, type WorkOrderInput } from './workOrder';

const SHA = 'a'.repeat(64);

function entry(over: Partial<CardReportEntry> = {}): CardReportEntry {
  return {
    name: 'Mystery Engine',
    oracleId: 'id-1',
    typeLine: 'Artifact',
    manaCost: '{2}',
    oracleText: 'Whenever the moon is full, flarb the zonk.',
    oracleSha256: SHA,
    status: 'unsupported',
    unmodeledReasons: ['unrecognized rules text: "Whenever the moon is full, flarb the zonk."'],
    scenarios: null,
    ...over,
  };
}

function row(e: CardReportEntry | null, over: Partial<ReportRow> = {}): ReportRow {
  return {
    name: e?.name ?? 'Unloaded Card',
    status: e?.status ?? 'unsupported',
    entry: e,
    ...over,
  };
}

const base: WorkOrderInput = {
  deckName: 'Test General, Elf',
  seat: 'P2',
  source: { kind: 'plaintext' },
  rows: [row(entry())],
  supportedKnown: false,
  labAvailable: false,
};

describe('workOrderFileName', () => {
  it('slugs the deck name', () => {
    expect(workOrderFileName("Atraxa, Praetors' Voice")).toBe(
      'decktank-work-order-atraxa-praetors-voice.md',
    );
    expect(workOrderFileName('Jorn, God of Winter // Kaldring')).toBe(
      'decktank-work-order-jorn-god-of-winter-kaldring.md',
    );
  });
  it('falls back when nothing is left of the name', () => {
    expect(workOrderFileName('!!!')).toBe('decktank-work-order-deck.md');
  });
  it('drops accents', () => {
    expect(workOrderFileName('Lim-Dûl')).toBe('decktank-work-order-lim-dul.md');
  });
});

describe('workOrderMarkdown', () => {
  it('has the six parts in order', () => {
    const md = workOrderMarkdown(base);
    const headings = md.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual([
      '## 1. Deck and source',
      '## 2. Goal',
      '## 3. Definition of done',
      '## 4. Cards that need work',
      '## 5. How to work in this repository',
      '## 6. Cards already supported',
    ]);
  });

  it('writes the real Oracle text, hash, reasons and status for a card', () => {
    const md = workOrderMarkdown(base);
    expect(md).toContain('### Mystery Engine');
    expect(md).toContain('- Status: Unsupported');
    expect(md).toContain(`\`${SHA}\``);
    expect(md).toContain('> Whenever the moon is full, flarb the zonk.');
    expect(md).toContain('unrecognized rules text');
    expect(md).toContain('- Source: a pasted decklist');
    expect(md).toContain('1 unsupported, 0 provisional');
  });

  it('copies the definition of done from the completion rule', () => {
    const md = workOrderMarkdown(base);
    for (const part of [
      'Oracle text is pinned',
      'Positive and negative engine scenarios',
      'normal cast or activation path',
      'Real-viewer evidence',
      'Gameplay-AI evidence is reported separately',
    ])
      expect(md).toContain(part);
    expect(md).toContain('`AGENTS.md`');
    expect(md).toContain('docs/guides/card-coverage-workflow.md');
    expect(md).toContain('Do not change supported cards');
  });

  it('says nothing is recorded instead of inventing evidence', () => {
    const md = workOrderMarkdown(base);
    expect(md).toContain('- Engine scenarios: No record');
    expect(md).toContain('- Real viewer: No record');
    expect(md).toContain('- Gameplay AI: No record');
    expect(md).not.toMatch(/Playwright run recorded|Engine tests recorded/);
    expect(md).toContain('- [ ] A faithful implementation');
  });

  it('shows recorded evidence, scenarios and clause ids only where they exist', () => {
    const md = workOrderMarkdown({
      ...base,
      labAvailable: true,
      rows: [
        row(
          entry({
            status: 'provisional',
            unmodeledReasons: [],
            scenarios: [{ id: 'lab-mystery', title: 'Moon is full', clauseIds: ['c1', 'c2'] }],
            evidence: { engine: 'engine-tests', viewer: 'not-run', gameplayAi: 'not-evaluated' },
          }),
        ),
      ],
    });
    expect(md).toContain('- Engine scenarios: Engine tests recorded');
    expect(md).toContain('- Real viewer: Not run');
    expect(md).toContain('`lab-mystery` Moon is full (clauses: c1, c2)');
    expect(md).toContain('- [ ] Real-viewer evidence from a Card Test Lab scenario');
    expect(md).not.toContain('- [ ] Engine evidence');
  });

  it('says when scenarios were not looked up, and when none match', () => {
    expect(workOrderMarkdown(base)).toContain('no Card Test Lab catalog');
    const none = workOrderMarkdown({
      ...base,
      labAvailable: true,
      rows: [row(entry({ scenarios: [] }))],
    });
    expect(none).toContain('no lab scenario pins this Oracle hash');
  });

  it('is honest about a card whose details never loaded', () => {
    const md = workOrderMarkdown({
      ...base,
      rows: [row(null, { name: 'Unloaded Card', oracleSha256: SHA })],
    });
    expect(md).toContain('### Unloaded Card');
    expect(md).toContain('Card details were not loaded');
    expect(md).not.toContain('Oracle text (pin');
  });

  it('lists supported cards only when they are known', () => {
    const unknown = workOrderMarkdown(base);
    expect(unknown).toContain('Not known for this source.');
    const supported = row(entry({ name: 'Forest', status: 'implemented-reviewed' }));
    const known = workOrderMarkdown({
      ...base,
      supportedKnown: true,
      rows: [row(entry()), supported],
    });
    expect(known).toContain('- Forest (Reviewed)');
    expect(known).toContain('Cards already supported: 1 distinct');
    expect(known).not.toContain('### Forest');
  });

  it('survives an empty list of cards that need work', () => {
    const md = workOrderMarkdown({ ...base, rows: [] });
    expect(md).toContain('No card needs work.');
    expect(md).toContain('# Work order: model 0 cards');
  });

  it('keeps multi-line names and text on one line where a heading needs it', () => {
    const md = workOrderMarkdown({
      ...base,
      deckName: 'Two\nLines',
      rows: [row(entry({ name: 'A\nB' }))],
    });
    expect(md).toContain('# Work order: model 1 card for Two Lines');
    expect(md).toContain('### A B');
  });
});
