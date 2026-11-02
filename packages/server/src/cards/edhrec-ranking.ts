/**
 * EDHREC popularity ranking: the real-world population that card coverage is measured against.
 *
 * EDHREC publishes two rankings over the same deck population: "Top Cards" (nonland cards) and
 * "Top Lands". Each entry carries `num_decks`, the number of decks that include the card. Because
 * Commander is singleton, summing `num_decks` over every card gives the number of nonbasic card
 * slots in all decks, so a card's `num_decks` is also its share of all slots played. Basic lands
 * are dropped: EDHREC counts a deck once however many copies of a basic it runs, so their counts
 * are not slot counts, and every basic land is modeled anyway.
 *
 * `bun run edhrec:fetch` freezes the ranking into `packages/server/fixtures/edhrec-ranking.json`
 * (cut at the share of slots below) and writes the 200-card staple list from it.
 * `bun run edhrec:ready-list` reads that file and writes the list of ranked cards that are modeled
 * or one rules line away from it.
 */

import type { CardCoverage } from './coverage';

export type EdhrecKind = 'nonland' | 'land';

/** One ranked card: `[name, decks including it, kind]`, a tuple to keep the frozen file small. */
export type EdhrecRow = [name: string, decks: number, kind: EdhrecKind];

export interface EdhrecRanking {
  /** The EDHREC JSON pages the ranking was read from. */
  sources: string[];
  /** Date the pages were fetched, `YYYY-MM-DD`. */
  fetchedAt: string;
  /** Decks in EDHREC's population (the largest `potential_decks` seen). */
  totalDecks: number;
  /** Nonbasic card slots over every ranked card, before the cut. */
  totalSlots: number;
  /** Distinct nonbasic cards ranked, before the cut. */
  rankedCards: number;
  /** The share of `totalSlots` the kept cards account for, at least. */
  slotShare: number;
  /** Ranked by decks, descending; ties by name. Only the cards inside `slotShare`. */
  cards: EdhrecRow[];
}

/** What EDHREC's JSON card lists hold per card; only these fields are read. */
export interface EdhrecCardView {
  name: string;
  num_decks: number;
  potential_decks: number;
}

/** The share of all nonbasic slots the frozen ranking keeps. */
export const DEFAULT_SLOT_SHARE = 0.95;

const BASIC_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);

export function isBasicLandName(name: string): boolean {
  return BASIC_NAMES.has(name.replace(/^Snow-Covered /, ''));
}

/**
 * Merge the two EDHREC lists into one ranking: basics dropped, sorted by decks descending and then
 * by name so the order is stable. Throws on a card present twice, which would double-count slots.
 */
export function rankEdhrecCards(
  nonland: readonly EdhrecCardView[],
  lands: readonly EdhrecCardView[],
): EdhrecRow[] {
  const rows: EdhrecRow[] = [];
  const seen = new Set<string>();
  const add = (view: EdhrecCardView, kind: EdhrecKind): void => {
    if (isBasicLandName(view.name)) return;
    if (seen.has(view.name)) throw new Error(`EDHREC ranking lists "${view.name}" twice`);
    if (!Number.isInteger(view.num_decks) || view.num_decks < 0)
      throw new Error(`EDHREC ranking has an invalid deck count for "${view.name}"`);
    seen.add(view.name);
    rows.push([view.name, view.num_decks, kind]);
  };
  for (const view of nonland) add(view, 'nonland');
  for (const view of lands) add(view, 'land');
  return rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The fewest top-ranked rows whose decks sum to at least `share` of every row's decks. */
export function cutAtSlotShare(
  rows: readonly EdhrecRow[],
  share: number,
): { cards: EdhrecRow[]; totalSlots: number } {
  if (!(share > 0 && share <= 1)) throw new Error(`slot share must be in (0, 1], got ${share}`);
  const totalSlots = rows.reduce((sum, row) => sum + row[1], 0);
  let covered = 0;
  let index = 0;
  while (index < rows.length && covered < share * totalSlots) covered += rows[index++]![1];
  return { cards: rows.slice(0, index), totalSlots };
}

/** The `count` most-included nonland cards: EDHREC's own "Top Cards" ranking. */
export function topNonlandNames(rows: readonly EdhrecRow[], count: number): string[] {
  const names = rows.filter((row) => row[2] === 'nonland').map((row) => row[0]);
  if (names.length < count) throw new Error(`ranking holds ${names.length} nonland cards`);
  return names.slice(0, count);
}

const UNRECOGNIZED_RE = /^unrecognized rules text: "(.*)"$/s;

export type Readiness = { status: 'modeled' } | { status: 'one-line'; line: string } | null;

/**
 * `modeled`: the interpreter models every line. `one-line`: exactly one rules line is not
 * understood and nothing else blocks the card. A card blocked by its layout, type, mana cost or
 * another structural reason is never one line away, even with a single reason: that reason is a
 * whole subsystem, not a sentence. Everything else is null.
 */
export function readiness(card: Pick<CardCoverage, 'modeled' | 'reasons'>): Readiness {
  if (card.modeled && card.reasons.length === 0) return { status: 'modeled' };
  if (card.modeled || card.reasons.length !== 1) return null;
  const match = UNRECOGNIZED_RE.exec(card.reasons[0]!);
  return match ? { status: 'one-line', line: match[1]! } : null;
}

export interface ReadyListEntry {
  rank: number;
  name: string;
  decks: number;
  kind: EdhrecKind;
  readiness: NonNullable<Readiness>;
}

export interface ReadyListSummary {
  ranking: EdhrecRanking;
  /** Where the Oracle text came from, e.g. the Scryfall bulk file and its date. */
  oracleSource: string;
  entries: ReadyListEntry[];
  /** Ranked cards that are neither modeled nor one line away. */
  otherCards: number;
  otherDecks: number;
}

const percent = (part: number, whole: number, digits = 1): string =>
  `${((part / whole) * 100).toFixed(digits)}%`;

/** Markdown inline code that survives backticks and line breaks in rules text. */
function inlineCode(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const fence = flat.includes('`') ? '``' : '`';
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** Escape the characters Markdown would read as emphasis or links in a card name. */
function escapeName(name: string): string {
  return name.replace(/([\\`*_[\]<>])/g, '\\$1');
}

/** The ready list as Markdown: summary, most common blocking lines, then both lists by rank. */
export function renderReadyList(summary: ReadyListSummary, recurringLines = 40): string {
  const { ranking, entries } = summary;
  const modeled = entries.filter((entry) => entry.readiness.status === 'modeled');
  const oneLine = entries.filter((entry) => entry.readiness.status === 'one-line');
  const decks = (list: readonly ReadyListEntry[]): number =>
    list.reduce((sum, entry) => sum + entry.decks, 0);
  const share = (n: number): string => percent(n, ranking.totalSlots, 2);
  const ofDecks = (n: number): string => percent(n, ranking.totalDecks, 2);
  const kept = ranking.cards.length;
  const keptSlots = decks(entries) + summary.otherDecks;

  const lineCounts = new Map<string, { cards: number; decks: number }>();
  for (const entry of oneLine) {
    if (entry.readiness.status !== 'one-line') continue;
    const key = entry.readiness.line;
    const count = lineCounts.get(key) ?? { cards: 0, decks: 0 };
    count.cards += 1;
    count.decks += entry.decks;
    lineCounts.set(key, count);
  }
  const recurring = [...lineCounts.entries()]
    .filter(([, count]) => count.cards > 1)
    .sort((a, b) => b[1].decks - a[1].decks || b[1].cards - a[1].cards || (a[0] < b[0] ? -1 : 1))
    .slice(0, recurringLines);

  const lines = [
    '# EDHREC cards that are modeled or one line away',
    '',
    `Generated by \`bun run edhrec:ready-list\`. Do not edit by hand.`,
    '',
    `The population is the ${kept} most-included cards on EDHREC, which together fill ${percent(keptSlots, ranking.totalSlots)} of the nonbasic card slots in ${ranking.totalDecks.toLocaleString('en-US')} Commander decks (fetched ${ranking.fetchedAt}, from \`packages/server/fixtures/edhrec-ranking.json\`). Oracle text: ${summary.oracleSource}.`,
    '',
    '"Modeled" means the interpreter reports no unhandled text for the card. It is not the verification standard in [Modeling a Card and Testing It](../guides/card-modeling-and-testing.md). "One line away" means exactly one rules line is not understood and nothing structural (layout, card type, mana cost) blocks the card.',
    '',
    `Each card shows its EDHREC rank among nonbasic cards and the share of decks that include it.`,
    '',
    `- Modeled: ${modeled.length} cards, ${share(decks(modeled))} of all nonbasic slots`,
    `- One line away: ${oneLine.length} cards, ${share(decks(oneLine))}`,
    `- Neither: ${summary.otherCards} cards, ${share(summary.otherDecks)}`,
    `- Ranked population: ${kept} cards, ${share(keptSlots)}`,
    '',
    '## Most common unhandled lines',
    '',
    'Lines that alone block more than one card, by the slots those cards fill. Card names are replaced by `~`.',
    '',
    ...recurring.map(
      ([line, count]) =>
        `- ${count.cards} cards, ${share(count.decks)} of slots: ${inlineCode(line)}`,
    ),
    '',
    `## One line away (${oneLine.length})`,
    '',
    ...oneLine.map(
      (entry) =>
        `- ${entry.rank}. ${escapeName(entry.name)} (${ofDecks(entry.decks)}): ${inlineCode(
          entry.readiness.status === 'one-line' ? entry.readiness.line : '',
        )}`,
    ),
    '',
    `## Modeled (${modeled.length})`,
    '',
    ...modeled.map(
      (entry) => `- ${entry.rank}. ${escapeName(entry.name)} (${ofDecks(entry.decks)})`,
    ),
    '',
  ];
  return lines.join('\n');
}
