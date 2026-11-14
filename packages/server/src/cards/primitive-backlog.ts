/**
 * The primitive backlog: card compiler refusals ranked by the deck slots each missing IR feature
 * would unlock. It answers "which primitive should we build next" with a number.
 *
 * The source of truth is `packages/server/fixtures/primitive-backlog-groups.json`. Each group is
 * one missing feature (a verb, reference, condition or cost form the card IR cannot say) with the
 * refused cards that need it. A person groups refusals by hand; `scripts/card-compiler/run.ts
 * report` appends each new refusal to `ungrouped` so the next trial feeds the backlog.
 *
 * `bun run primitive-backlog` ranks the groups by EDHREC slot share and writes
 * `packages/server/fixtures/primitive-backlog.json` (the queue the composable vocabulary work reads)
 * and `docs/plans/primitive-backlog.md`. Everything is offline.
 */

import type { EdhrecRanking } from './edhrec-ranking';

/** The hand-edited groups file, relative to the repo root. */
export const PRIMITIVE_BACKLOG_GROUPS_PATH =
  'packages/server/fixtures/primitive-backlog-groups.json';

/** The XMage scan's verdict on a card, as `scripts/card-compiler/select.ts` labels it. */
export type XmageBucket = 'xmage-known-classes' | 'xmage-custom-classes' | 'xmage-missing';

/** One compiler refusal: the card, the trial that refused it, and the compiler's reason. */
export interface RefusalEntry {
  name: string;
  /** The trial directory, e.g. `docs/reviews/card-compiler-trial-02`. */
  trial: string;
  reason: string;
  xmageBucket?: XmageBucket;
}

export interface RefusalGroup {
  feature: string;
  description: string;
  cards: RefusalEntry[];
}

/** The hand-edited groups file. */
export interface BacklogGroupsFile {
  about?: string;
  xmageScan?: string;
  groups: RefusalGroup[];
  /** Refusals whose line needs a bespoke mechanic no other card shares. Not ranked as a feature. */
  oneOff: RefusalEntry[];
  /** New refusals that nobody has grouped yet. */
  ungrouped: RefusalEntry[];
}

/** Why a refused card no longer counts: it is modeled now, or a patch for it is in the queue. */
export type UnblockedBy = 'modeled' | 'compiled-checked' | 'provisional';

export interface BacklogCard {
  name: string;
  /** EDHREC rank, 1-based, or null when the card is outside the frozen ranking. */
  rank: number | null;
  decks: number;
  /** 1 / the number of groups the card is listed in. */
  weight: number;
  xmageBucket?: XmageBucket;
  trial: string;
  reason: string;
}

export interface BacklogFeature {
  feature: string;
  description: string;
  /** Cards still blocked in this group. */
  cards: number;
  /** Cards weighted by 1 / (groups each card needs), so shared cards are not counted as free. */
  weightedCards: number;
  /** Weighted decks over every card in the group. */
  weightedDecks: number;
  /** `weightedDecks / totalSlots`: the share of all nonbasic deck slots the feature unlocks. */
  slotShare: number;
  /** Cards XMage implements with shared ability classes only, so XMage can serve as a spec. */
  xmageKnown: number;
  /** Every still-blocked card, by rank (unranked last). */
  members: BacklogCard[];
}

export interface PrimitiveBacklog {
  totalSlots: number;
  /** Distinct refused cards in the groups file, blocked or not. */
  refusals: number;
  trials: string[];
  /** Ranked by slot share, then weighted cards, then name. */
  features: BacklogFeature[];
  /** Still-blocked cards listed in two or more groups. */
  multiGroupCards: number;
  oneOff: BacklogCard[];
  ungrouped: BacklogCard[];
  unblocked: { name: string; by: UnblockedBy }[];
  /** Refused cards not in the EDHREC ranking (they count zero slots). */
  unranked: string[];
}

export interface BacklogInput {
  groups: BacklogGroupsFile;
  ranking: EdhrecRanking;
  /** Cards that left the backlog, by name. */
  unblocked: ReadonlyMap<string, UnblockedBy>;
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function byRank(a: BacklogCard, b: BacklogCard): number {
  if (a.rank === null || b.rank === null) {
    if (a.rank !== b.rank) return a.rank === null ? 1 : -1;
    return byName(a.name, b.name);
  }
  return a.rank - b.rank;
}

/** Rank the groups file against the EDHREC ranking. Pure; the CLI does the file reads. */
export function buildPrimitiveBacklog(input: BacklogInput): PrimitiveBacklog {
  const { groups, ranking, unblocked } = input;
  const position = new Map<string, number>();
  ranking.cards.forEach(([name], index) => {
    position.set(name, index);
  });

  const groupCount = new Map<string, number>();
  for (const group of groups.groups) {
    for (const name of new Set(group.cards.map((card) => card.name))) {
      groupCount.set(name, (groupCount.get(name) ?? 0) + 1);
    }
  }

  const unranked = new Set<string>();
  const toCard = (entry: RefusalEntry): BacklogCard => {
    const index = position.get(entry.name);
    if (index === undefined) unranked.add(entry.name);
    const card: BacklogCard = {
      name: entry.name,
      rank: index === undefined ? null : index + 1,
      decks: index === undefined ? 0 : ranking.cards[index]![1],
      weight: 1 / (groupCount.get(entry.name) ?? 1),
      trial: entry.trial,
      reason: entry.reason,
    };
    if (entry.xmageBucket !== undefined) card.xmageBucket = entry.xmageBucket;
    return card;
  };
  const blocked = (entry: RefusalEntry): boolean => !unblocked.has(entry.name);
  const unique = (entries: readonly RefusalEntry[]): RefusalEntry[] => {
    const seen = new Set<string>();
    return entries.filter((entry) => !seen.has(entry.name) && seen.add(entry.name) !== undefined);
  };

  const features: BacklogFeature[] = groups.groups.map((group) => {
    const members = unique(group.cards).filter(blocked).map(toCard).sort(byRank);
    const weightedDecks = members.reduce((sum, card) => sum + card.decks * card.weight, 0);
    return {
      feature: group.feature,
      description: group.description,
      cards: members.length,
      weightedCards: members.reduce((sum, card) => sum + card.weight, 0),
      weightedDecks,
      slotShare: weightedDecks / ranking.totalSlots,
      xmageKnown: members.filter((card) => card.xmageBucket === 'xmage-known-classes').length,
      members,
    };
  });
  features.sort(
    (a, b) =>
      b.weightedDecks - a.weightedDecks ||
      b.weightedCards - a.weightedCards ||
      byName(a.feature, b.feature),
  );

  const grouped = new Set(groupCount.keys());
  const bySlots = (a: BacklogCard, b: BacklogCard): number =>
    b.decks - a.decks || byName(a.name, b.name);
  const oneOff = unique(groups.oneOff)
    .filter((entry) => blocked(entry) && !grouped.has(entry.name))
    .map(toCard)
    .sort(bySlots);
  const oneOffNames = new Set(oneOff.map((card) => card.name));
  const ungrouped = unique(groups.ungrouped)
    .filter((entry) => blocked(entry) && !grouped.has(entry.name) && !oneOffNames.has(entry.name))
    .map(toCard)
    .sort(bySlots);

  const all = [
    ...groups.groups.flatMap((group) => group.cards),
    ...groups.oneOff,
    ...groups.ungrouped,
  ];
  const names = new Set(all.map((entry) => entry.name));
  return {
    totalSlots: ranking.totalSlots,
    refusals: names.size,
    trials: [...new Set(all.map((entry) => entry.trial))].sort(byName),
    features,
    multiGroupCards: [...groupCount.entries()].filter(
      ([name, count]) => count > 1 && !unblocked.has(name),
    ).length,
    oneOff,
    ungrouped,
    unblocked: [...names]
      .filter((name) => unblocked.has(name))
      .sort(byName)
      .map((name) => ({ name, by: unblocked.get(name)! })),
    unranked: [...unranked].sort(byName),
  };
}

/**
 * Append refusals that the groups file does not list anywhere to `ungrouped`. Returns the names
 * added. A card already in a group, in `oneOff` or in `ungrouped` is left alone, so re-running a
 * trial report is a no-op.
 */
export function appendRefusals(
  file: BacklogGroupsFile,
  refusals: readonly RefusalEntry[],
): string[] {
  const listed = new Set([
    ...file.groups.flatMap((group) => group.cards.map((card) => card.name)),
    ...file.oneOff.map((card) => card.name),
    ...file.ungrouped.map((card) => card.name),
  ]);
  const added: string[] = [];
  for (const refusal of refusals) {
    if (listed.has(refusal.name)) continue;
    listed.add(refusal.name);
    file.ungrouped.push({ ...refusal });
    added.push(refusal.name);
  }
  return added;
}

export function renderGroupsFile(file: BacklogGroupsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/** The machine-readable queue: one feature per line block, rounded so the file is stable. */
export function renderBacklogJson(backlog: PrimitiveBacklog): string {
  const card = (c: BacklogCard) => ({
    name: c.name,
    rank: c.rank,
    decks: c.decks,
    ...(c.weight === 1 ? {} : { weight: round(c.weight, 4) }),
    ...(c.xmageBucket === undefined ? {} : { xmageBucket: c.xmageBucket }),
    trial: c.trial,
    reason: c.reason,
  });
  const json = {
    generatedBy: 'bun run primitive-backlog',
    source: 'packages/server/fixtures/primitive-backlog-groups.json',
    totalSlots: backlog.totalSlots,
    refusals: backlog.refusals,
    trials: backlog.trials,
    multiGroupCards: backlog.multiGroupCards,
    features: backlog.features.map((feature, index) => ({
      rank: index + 1,
      feature: feature.feature,
      description: feature.description,
      cards: feature.cards,
      weightedCards: round(feature.weightedCards, 4),
      weightedDecks: Math.round(feature.weightedDecks),
      slotShare: round(feature.slotShare, 8),
      xmageKnown: feature.xmageKnown,
      members: feature.members.map(card),
    })),
    oneOff: backlog.oneOff.map(card),
    ungrouped: backlog.ungrouped.map(card),
    unblocked: backlog.unblocked,
    unranked: backlog.unranked,
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

const percent = (share: number): string => `${(share * 100).toFixed(3)}%`;
const cell = (text: string): string => text.replace(/\|/g, '\\|');

export interface BacklogMarkdownOptions {
  /** Feature rows in the main table. */
  top?: number;
  /** Cards named per feature. */
  cardsPerFeature?: number;
  /** One-off cards listed. */
  oneOffRows?: number;
}

export function renderBacklogMarkdown(
  backlog: PrimitiveBacklog,
  options: BacklogMarkdownOptions = {},
): string {
  const top = options.top ?? 20;
  const cardsPerFeature = options.cardsPerFeature ?? 5;
  const oneOffRows = options.oneOffRows ?? 15;
  const blockedCards =
    new Set(backlog.features.flatMap((feature) => feature.members.map((card) => card.name))).size +
    backlog.oneOff.length +
    backlog.ungrouped.length;
  const names = (cards: readonly BacklogCard[]): string =>
    cards
      .slice(0, cardsPerFeature)
      .map((card) => cell(card.name))
      .join(', ');

  const out: string[] = [
    '# Primitive backlog: compiler refusals ranked by deck slots',
    '',
    'Generated by `bun run primitive-backlog`. Do not edit by hand; edit `packages/server/fixtures/primitive-backlog-groups.json` and regenerate.',
    '',
    `**Sample.** ${backlog.refusals} cards the card compiler refused as inexpressible, from ${backlog.trials.length} trial${backlog.trials.length === 1 ? '' : 's'} (${backlog.trials.map((trial) => `\`${trial}\``).join(', ')}). Each trial drew its cards from the pool of EDHREC cards blocked by one rules line, so this is a sample of the gaps, not a census. ${blockedCards} are still blocked; ${backlog.unblocked.length} have since been modeled or compiled and leave the ranking.`,
    '',
    `**How the rank works.** A feature's score is the sum of its cards' EDHREC deck counts as a share of all ${backlog.totalSlots.toLocaleString('en-US')} nonbasic deck slots. A card that needs k features counts 1/k toward each (${backlog.multiGroupCards} card${backlog.multiGroupCards === 1 ? ' does' : 's do'} now), so a card that also needs another missing feature does not look free. Slot share, not card count, separates a staple from a long-tail card. "XMage spec" counts cards XMage implements with shared ability classes only, where its code can serve as a specification. Machine-readable queue: \`packages/server/fixtures/primitive-backlog.json\`.`,
    '',
    `## Top ${Math.min(top, backlog.features.length)} features`,
    '',
    '| # | Missing feature | Cards | Share of slots | XMage spec | Top cards |',
    '| -: | --------------- | ----: | -------------: | ---------: | --------- |',
    ...backlog.features
      .slice(0, top)
      .map(
        (feature, index) =>
          `| ${index + 1} | ${cell(feature.feature)} | ${feature.cards} | ${percent(feature.slotShare)} | ${feature.xmageKnown} | ${names(feature.members)} |`,
      ),
  ];
  const rest = backlog.features.slice(top);
  if (rest.length > 0) {
    out.push(
      '',
      `${rest.length} more feature${rest.length === 1 ? '' : 's'}, ${rest.reduce((sum, f) => sum + f.cards, 0)} cards together, ${percent(rest.reduce((sum, f) => sum + f.slotShare, 0))} of slots: ${rest.map((f) => `${cell(f.feature)} (${f.cards})`).join('; ')}.`,
    );
  }
  out.push(
    '',
    '## Needs grouping',
    '',
    backlog.ungrouped.length === 0
      ? 'None. Every refusal is in a group or marked one-off.'
      : `${backlog.ungrouped.length} new refusal${backlog.ungrouped.length === 1 ? '' : 's'} not yet in a group. Move each into a group (or \`oneOff\`) in the groups file.`,
    ...(backlog.ungrouped.length === 0
      ? []
      : [
          '',
          '| Card | Share of slots | Reason |',
          '| ---- | -------------: | ------ |',
          ...backlog.ungrouped.map(
            (card) =>
              `| ${cell(card.name)} | ${percent(card.decks / backlog.totalSlots)} | ${cell(card.reason)} |`,
          ),
        ]),
    '',
    '## One-off mechanics',
    '',
    `${backlog.oneOff.length} cards need a mechanic no other refused card shares, so they are not ranked as features. The ${Math.min(oneOffRows, backlog.oneOff.length)} most played:`,
    '',
    '| Card | Share of slots | Reason |',
    '| ---- | -------------: | ------ |',
    ...backlog.oneOff
      .slice(0, oneOffRows)
      .map(
        (card) =>
          `| ${cell(card.name)} | ${percent(card.decks / backlog.totalSlots)} | ${cell(card.reason)} |`,
      ),
  );
  if (backlog.unblocked.length > 0) {
    out.push(
      '',
      '## Unblocked since refusal',
      '',
      `These cards are modeled now or have a checked patch in the review queue, so they no longer count: ${backlog.unblocked.map((card) => `${cell(card.name)} (${card.by})`).join(', ')}.`,
    );
  }
  if (backlog.unranked.length > 0) {
    out.push(
      '',
      `Not in the EDHREC ranking (count zero slots): ${backlog.unranked.map(cell).join(', ')}.`,
    );
  }
  return `${out.join('\n')}\n`;
}
