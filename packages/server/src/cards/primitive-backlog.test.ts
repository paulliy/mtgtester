import { describe, expect, it } from 'vitest';
import type { EdhrecRanking } from './edhrec-ranking';
import {
  appendRefusals,
  buildPrimitiveBacklog,
  queueEntryUnblocks,
  type QueueCard,
  renderBacklogJson,
  renderBacklogMarkdown,
  renderGroupsFile,
  type BacklogGroupsFile,
  type RefusalEntry,
  type UnblockedBy,
} from './primitive-backlog';

const ranking: EdhrecRanking = {
  sources: [],
  fetchedAt: '2026-11-02',
  totalDecks: 1000,
  totalSlots: 10_000,
  rankedCards: 6,
  slotShare: 0.95,
  cards: [
    ['Staple', 900, 'nonland'],
    ['Shared Card', 600, 'nonland'],
    ['Mid Card', 300, 'nonland'],
    ['Low Card', 100, 'nonland'],
    ['Odd Card', 50, 'nonland'],
    ['Done Card', 40, 'nonland'],
  ],
};

const refusal = (name: string, extra: Partial<RefusalEntry> = {}): RefusalEntry => ({
  name,
  trial: 'docs/reviews/card-compiler-trial-02',
  reason: `${name} cannot be said`,
  ...extra,
});

/** Three groups: one staple, two sharing a card that needs both features. */
function fixture(): BacklogGroupsFile {
  return {
    groups: [
      { feature: 'A', description: 'one staple', cards: [refusal('Staple')] },
      {
        feature: 'B',
        description: 'shared card plus a mid card',
        cards: [
          refusal('Shared Card', { xmageBucket: 'xmage-known-classes' }),
          refusal('Mid Card', { xmageBucket: 'xmage-custom-classes' }),
        ],
      },
      {
        feature: 'C',
        description: 'shared card plus a low card and a modeled card',
        cards: [refusal('Shared Card'), refusal('Low Card'), refusal('Done Card')],
      },
    ],
    oneOff: [refusal('Odd Card', { trial: 'docs/reviews/card-compiler-trial-01' })],
    ungrouped: [],
  };
}

const build = (
  groups = fixture(),
  unblocked = new Map<string, UnblockedBy>([['Done Card', 'modeled']]),
) => buildPrimitiveBacklog({ groups, ranking, unblocked });

describe('buildPrimitiveBacklog', () => {
  it('ranks features by weighted slot share, halving a card that needs two features', () => {
    const backlog = build();
    // A: 900. B: 600/2 + 300 = 600. C: 600/2 + 100 = 400.
    expect(backlog.features.map((f) => [f.feature, f.weightedDecks])).toEqual([
      ['A', 900],
      ['B', 600],
      ['C', 400],
    ]);
    const b = backlog.features[1]!;
    expect(b.cards).toBe(2);
    expect(b.weightedCards).toBe(1.5);
    expect(b.slotShare).toBeCloseTo(0.06);
    expect(b.members.map((card) => [card.name, card.weight])).toEqual([
      ['Shared Card', 0.5],
      ['Mid Card', 1],
    ]);
    expect(b.xmageKnown).toBe(1);
    expect(backlog.multiFeatureCards).toBe(1);
  });

  it('drops unblocked cards from the ranking and lists them', () => {
    const backlog = build();
    const c = backlog.features.find((f) => f.feature === 'C')!;
    expect(c.members.map((card) => card.name)).toEqual(['Shared Card', 'Low Card']);
    expect(backlog.unblocked).toEqual([{ name: 'Done Card', by: 'modeled' }]);
    expect(backlog.refusals).toBe(6);
  });

  it('gives a shared card full weight again once its other feature is the only one', () => {
    const groups = fixture();
    groups.groups[2]!.cards = groups.groups[2]!.cards.filter((card) => card.name !== 'Shared Card');
    const b = build(groups).features.find((f) => f.feature === 'B')!;
    expect(b.weightedDecks).toBe(900);
  });

  it('keeps one-off and ungrouped cards out of the features and puts unranked cards last', () => {
    const groups = fixture();
    groups.ungrouped.push(refusal('Not Ranked'), refusal('Staple'));
    groups.groups[0]!.cards.push(refusal('Also Unranked'));
    const backlog = build(groups);
    expect(backlog.oneOff.map((card) => card.name)).toEqual(['Odd Card']);
    // Staple is already grouped, so only the new card needs grouping.
    expect(backlog.ungrouped.map((card) => [card.name, card.rank, card.decks])).toEqual([
      ['Not Ranked', null, 0],
    ]);
    expect(backlog.features[0]!.members.map((card) => card.name)).toEqual([
      'Staple',
      'Also Unranked',
    ]);
    expect(backlog.unranked).toEqual(['Also Unranked', 'Not Ranked']);
    expect(backlog.trials).toEqual([
      'docs/reviews/card-compiler-trial-01',
      'docs/reviews/card-compiler-trial-02',
    ]);
  });
});

describe('weighting and edge cases', () => {
  it('counts alsoNeeds like another group in the 1/k weight', () => {
    const groups = fixture();
    groups.groups[0]!.cards[0]!.alsoNeeds = ['a bespoke mechanic'];
    const backlog = build(groups);
    const a = backlog.features.find((f) => f.feature === 'A')!;
    expect(a.weightedDecks).toBe(450);
    expect(a.members[0]!.weight).toBe(0.5);
    expect(backlog.multiFeatureCards).toBe(2);
  });

  it('leaves out a group whose cards are all unblocked and names it', () => {
    const backlog = build(
      fixture(),
      new Map<string, UnblockedBy>([
        ['Done Card', 'modeled'],
        ['Staple', 'review-queue'],
      ]),
    );
    expect(backlog.features.map((f) => f.feature)).toEqual(['B', 'C']);
    expect(backlog.clearedFeatures).toEqual(['A']);
    expect(renderBacklogMarkdown(backlog)).toContain('Features with no blocked card left: A.');
  });

  it('counts a card shared by two tail features once in the tail summary', () => {
    const markdown = renderBacklogMarkdown(build(), { top: 1 });
    expect(markdown).toContain('2 more features, 3 cards together');
  });

  it('refuses a ranking with no slots', () => {
    expect(() =>
      buildPrimitiveBacklog({
        groups: fixture(),
        ranking: { ...ranking, totalSlots: 0 },
        unblocked: new Map(),
      }),
    ).toThrow(/no slots/);
  });
});

describe('queueEntryUnblocks', () => {
  const entry: QueueCard = {
    name: 'Checked',
    oracleId: 'oid',
    status: 'compiled-checked',
    patch: 'patches/checked.json',
    patchSha256: 'abc',
    review: null,
  };
  const hashes = (sha: string | null) => () => sha;
  const none = new Set<string>();

  it('admits a checked entry whose patch still matches its recorded hash', () => {
    expect(queueEntryUnblocks(entry, none, hashes('abc'))).toBe(true);
  });

  it('rejects an edited or missing patch, or an entry with no patch', () => {
    expect(queueEntryUnblocks(entry, none, hashes('0'.repeat(64)))).toBe(false);
    expect(queueEntryUnblocks(entry, none, hashes(null))).toBe(false);
    expect(queueEntryUnblocks({ ...entry, patch: null }, none, hashes('abc'))).toBe(false);
    expect(queueEntryUnblocks({ ...entry, patchSha256: null }, none, hashes('abc'))).toBe(false);
  });

  it('rejects other statuses, rejected reviews, differing cross-checks and demoted patches', () => {
    expect(queueEntryUnblocks({ ...entry, status: 'meaning-differs' }, none, hashes('abc'))).toBe(
      false,
    );
    expect(
      queueEntryUnblocks({ ...entry, review: { verdict: 'rejected' } }, none, hashes('abc')),
    ).toBe(false);
    expect(
      queueEntryUnblocks({ ...entry, crossCheck: { verdict: 'differs' } }, none, hashes('abc')),
    ).toBe(false);
    expect(queueEntryUnblocks(entry, new Set(['oid|abc']), hashes('abc'))).toBe(false);
  });
});

describe('appendRefusals', () => {
  it('adds only cards the file does not list yet, so a re-run is a no-op', () => {
    const file = fixture();
    const added = appendRefusals(file, [
      refusal('Staple'),
      refusal('Odd Card'),
      refusal('Brand New', { trial: 'docs/reviews/card-compiler-trial-03' }),
      refusal('Brand New'),
    ]);
    expect(added).toEqual(['Brand New']);
    expect(file.ungrouped).toEqual([
      refusal('Brand New', { trial: 'docs/reviews/card-compiler-trial-03' }),
    ]);
    const before = renderGroupsFile(file);
    expect(appendRefusals(file, [refusal('Brand New')])).toEqual([]);
    expect(renderGroupsFile(file)).toBe(before);
  });
});

describe('rendering', () => {
  it('writes the queue and report deterministically, with ungrouped refusals at the bottom', () => {
    const groups = fixture();
    appendRefusals(groups, [refusal('Mystery | Card')]);
    const backlog = build(groups);
    expect(renderBacklogJson(backlog)).toBe(renderBacklogJson(build(groups)));
    const json = JSON.parse(renderBacklogJson(backlog)) as {
      features: { rank: number; feature: string; members: { name: string; weight?: number }[] }[];
    };
    expect(json.features.map((f) => [f.rank, f.feature])).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
    ]);
    expect(json.features[1]!.members[0]).toMatchObject({ name: 'Shared Card', weight: 0.5 });
    expect(json.features[0]!.members[0]).not.toHaveProperty('weight');

    const markdown = renderBacklogMarkdown(backlog);
    expect(markdown).toContain('| 1 | A | 1 | 9.000% | 0 | Staple |');
    expect(markdown).toContain('| 2 | B | 2 | 6.000% | 1 | Shared Card, Mid Card |');
    expect(markdown).toContain('7 cards the card compiler refused');
    expect(markdown).toContain('1 new refusal not yet in a group');
    expect(markdown).toContain('| Mystery \\| Card | 0.000% |');
    expect(markdown.indexOf('## Needs grouping')).toBeGreaterThan(markdown.indexOf('## Top'));
  });
});
