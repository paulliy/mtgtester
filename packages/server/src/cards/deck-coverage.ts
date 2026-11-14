/**
 * Deck-level coverage: how many whole decks the engine can play start to finish.
 *
 * Slot share (`bun run coverage`, `bun run staples`) counts cards. A deck halts on its first
 * unmodeled card (brief §6.3), so a 95% card figure can still mean almost no playable decks. This
 * module measures the deck figure directly. Each card in a deck is one of:
 *
 * - **modeled**: `interpretCard` models it today.
 * - **provisional**: not modeled, but a compiled card waits in review for it (see
 *   `ProvisionalLookup`). Not playable yet; counted separately so the metric shows what accepting
 *   provisional cards would buy, without letting it pass for real coverage.
 * - **blocking**: neither.
 *
 * A deck is "playable exactly" when every card is modeled, and "playable with provisional" when
 * every card is modeled or provisional. The second count includes the first.
 */

import type { OracleCard } from '@mtg/shared';
import { measureCoverage } from './coverage';

/**
 * Whether an unmodeled card has a provisional definition. This is the one seam the provisional
 * column depends on: today the CLI builds it from the compiled-card review queue
 * (`provisionalFromQueue`), and the provisional trust tier can replace it with its own loader
 * without touching anything else here. `NO_PROVISIONAL` turns the column into a copy of the
 * exact one.
 */
export type ProvisionalLookup = (card: OracleCard) => boolean;

export const NO_PROVISIONAL: ProvisionalLookup = () => false;

export interface DeckInput {
  name: string;
  /** Every card in the deck, commanders and companion included. Duplicates are ignored. */
  cards: readonly OracleCard[];
  /** Names that could not be resolved to an Oracle record. Each one blocks the deck. */
  unresolved?: readonly string[];
}

export type DeckVerdict = 'exact' | 'provisional' | 'blocked';

export interface DeckResult {
  name: string;
  verdict: DeckVerdict;
  uniqueCards: number;
  modeled: number;
  /** Unmodeled cards with a provisional definition, by name. */
  provisional: string[];
  /** Unmodeled cards with nothing, by name. */
  blocking: string[];
}

/** A card worth modeling, ranked by how many decks it would finish unblocking. */
export interface UnblockRow {
  name: string;
  /** Decks in which this card is the only unmodeled card. */
  onlyBlocker: number;
  /** Decks in which this card is one of exactly two unmodeled cards. */
  oneOfTwo: number;
  /** Every deck the card is unmodeled in. */
  decks: number;
  provisional: boolean;
}

export interface DeckCoverageSummary {
  decks: number;
  playableExactly: number;
  playableWithProvisional: number;
  /** Decks with at most N unmodeled cards (provisional ones count as unmodeled), by N. */
  atMostUnmodeled: Record<'1' | '2' | '5', number>;
}

export interface DeckCoverageReport {
  summary: DeckCoverageSummary;
  decks: DeckResult[];
  unblock: UnblockRow[];
}

const AT_MOST = [1, 2, 5] as const;

/**
 * Measure a deck population. Each distinct card is interpreted once (via `measureCoverage`).
 *
 * The unblock ranking counts every unmodeled card, provisional ones included, because a
 * provisional card blocks the exact column until it is accepted. It is greedy and per card: the
 * first count is decks this card alone would unblock, the second is decks it would unblock
 * together with one other card.
 */
export function measureDeckCoverage(
  decks: readonly DeckInput[],
  provisional: ProvisionalLookup = NO_PROVISIONAL,
): DeckCoverageReport {
  const coverage = measureCoverage(
    decks.map((deck) => ({ name: deck.name, cards: [...deck.cards] })),
  );
  const modeled = new Map(coverage.cards.map((card) => [card.oracleId, card.modeled]));

  const results: DeckResult[] = [];
  const rows = new Map<string, UnblockRow>();
  for (const deck of decks) {
    const seen = new Set<string>();
    const provisionalNames: string[] = [];
    const blocking: string[] = [];
    const unmodeled: { name: string; provisional: boolean }[] = [];
    for (const card of deck.cards) {
      if (seen.has(card.oracleId)) continue;
      seen.add(card.oracleId);
      if (modeled.get(card.oracleId) === true) continue;
      const isProvisional = provisional(card);
      (isProvisional ? provisionalNames : blocking).push(card.name);
      unmodeled.push({ name: card.name, provisional: isProvisional });
    }
    for (const name of new Set(deck.unresolved ?? [])) {
      blocking.push(name);
      unmodeled.push({ name, provisional: false });
    }
    for (const card of unmodeled) {
      const row = rows.get(card.name) ?? {
        name: card.name,
        onlyBlocker: 0,
        oneOfTwo: 0,
        decks: 0,
        provisional: card.provisional,
      };
      row.decks++;
      if (unmodeled.length === 1) row.onlyBlocker++;
      if (unmodeled.length === 2) row.oneOfTwo++;
      rows.set(card.name, row);
    }
    results.push({
      name: deck.name,
      verdict: unmodeled.length === 0 ? 'exact' : blocking.length === 0 ? 'provisional' : 'blocked',
      uniqueCards: seen.size + new Set(deck.unresolved ?? []).size,
      modeled: seen.size + new Set(deck.unresolved ?? []).size - unmodeled.length,
      provisional: provisionalNames.sort(),
      blocking: blocking.sort(),
    });
  }

  const unmodeledCount = (deck: DeckResult) => deck.provisional.length + deck.blocking.length;
  const atMost = (limit: number) => results.filter((deck) => unmodeledCount(deck) <= limit).length;
  return {
    summary: {
      decks: results.length,
      playableExactly: results.filter((deck) => deck.verdict === 'exact').length,
      playableWithProvisional: results.filter((deck) => deck.verdict !== 'blocked').length,
      atMostUnmodeled: Object.fromEntries(
        AT_MOST.map((limit) => [String(limit), atMost(limit)]),
      ) as DeckCoverageSummary['atMostUnmodeled'],
    },
    decks: results,
    unblock: [...rows.values()].sort(
      (a, b) =>
        b.onlyBlocker - a.onlyBlocker ||
        b.oneOfTwo - a.oneOfTwo ||
        b.decks - a.decks ||
        a.name.localeCompare(b.name),
    ),
  };
}

/** One measured population, as the committed report records it. */
export interface PopulationReport extends DeckCoverageReport {
  /** Short label, e.g. "fixture decks". */
  name: string;
  /** Where the decks came from, for the report's reader. */
  source: string;
}

/** A queue entry, as far as this metric reads it. The full type lives in scripts/card-compiler. */
export interface QueueEntryView {
  oracleId: string;
  status: string;
  patch: string | null;
  patchSha256: string | null;
  review: { verdict: 'accepted' | 'rejected' } | null;
}

/**
 * Provisional lookup from the compiled-card review queue: a card is provisional when some entry
 * for its Oracle id is `compiled-checked`, was not rejected, and its patch file still hashes to
 * the recorded `patchSha256` (a changed patch is no longer the one that was checked).
 * `hashPatch` returns null for a missing file.
 */
export function provisionalFromQueue(
  entries: readonly QueueEntryView[],
  hashPatch: (path: string) => string | null,
): ProvisionalLookup {
  const ids = new Set(
    entries
      .filter(
        (entry) =>
          entry.status === 'compiled-checked' &&
          entry.review?.verdict !== 'rejected' &&
          entry.patch !== null &&
          entry.patchSha256 !== null &&
          hashPatch(entry.patch) === entry.patchSha256,
      )
      .map((entry) => entry.oracleId),
  );
  return (card) => ids.has(card.oracleId);
}

/** The headline as one line, for `bun run coverage` and `bun run staples`. */
export function headline(population: PopulationReport): string {
  const { decks, playableExactly, playableWithProvisional, atMostUnmodeled } = population.summary;
  return (
    `Deck coverage (${population.name}): ${playableExactly}/${decks} playable exactly, ` +
    `${playableWithProvisional}/${decks} with provisional cards, ` +
    `${atMostUnmodeled['2']}/${decks} within 2 cards.`
  );
}

export const DECK_COVERAGE_PATH = 'packages/server/fixtures/deck-coverage.json';

/**
 * The headline of each population in the committed report, for printing beside slot share.
 * Reads the committed file rather than re-measuring: `deck-coverage --check` keeps it current.
 */
export function committedHeadlines(reportText: string): string[] {
  const report = JSON.parse(reportText) as { populations: PopulationReport[] };
  return report.populations.map(headline);
}

/** The committed JSON: summary and decks, one deck per line, so a diff names the decks that moved. */
export function renderDeckCoverageJson(populations: readonly PopulationReport[]): string {
  const parts = populations.map((population) => {
    const head = JSON.stringify(
      { name: population.name, source: population.source, summary: population.summary },
      null,
      2,
    )
      .replace(/\n}$/, '')
      .replace(/\n/g, '\n    ');
    const decks = population.decks.map((deck) => `        ${JSON.stringify(deck)}`).join(',\n');
    const unblock = population.unblock.map((row) => `        ${JSON.stringify(row)}`).join(',\n');
    return (
      `    ${head},\n` +
      `      "decks": [${decks === '' ? '' : `\n${decks}\n      `}],\n` +
      `      "unblock": [${unblock === '' ? '' : `\n${unblock}\n      `}]\n    }`
    );
  });
  return `{\n  "populations": [\n${parts.join(',\n')}\n  ]\n}\n`;
}

const SHOWN_BLOCKERS = 6;
const SHOWN_UNBLOCK = 40;

function cardList(names: readonly string[]): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, SHOWN_BLOCKERS).join(', ');
  return names.length > SHOWN_BLOCKERS ? `${shown}, +${names.length - SHOWN_BLOCKERS} more` : shown;
}

export function renderDeckCoverageMarkdown(populations: readonly PopulationReport[]): string {
  const out: string[] = [
    '# Deck coverage: whole decks the engine can play',
    '',
    'Generated by `bun run deck-coverage`. Do not edit by hand. Machine-readable report: `packages/server/fixtures/deck-coverage.json`.',
    '',
    'A deck halts on its first unmodeled card, so this counts whole decks rather than card slots. **Playable exactly**: every card is modeled. **With provisional**: every card is modeled or has a compiled definition waiting in the review queue (not playable until provisional cards are allowed; the count includes the exact decks). **Within N**: at most N unmodeled cards, provisional ones included.',
    '',
    '| Population | Decks | Playable exactly | With provisional | Within 1 | Within 2 | Within 5 |',
    '| ---------- | ----: | ---------------: | ---------------: | -------: | -------: | -------: |',
    ...populations.map(({ name, summary: s }) =>
      [
        '',
        name,
        s.decks,
        s.playableExactly,
        s.playableWithProvisional,
        s.atMostUnmodeled['1'],
        s.atMostUnmodeled['2'],
        s.atMostUnmodeled['5'],
        '',
      ]
        .join(' | ')
        .trim(),
    ),
  ];
  for (const population of populations) {
    out.push('', `## ${population.name}`, '', `Source: ${population.source}.`, '');
    out.push(
      '| Deck | Verdict | Modeled | Provisional | Blocking |',
      '| ---- | ------- | ------: | ----------- | -------- |',
      ...population.decks.map(
        (deck) =>
          `| ${deck.name} | ${deck.verdict} | ${deck.modeled}/${deck.uniqueCards} | ${cardList(deck.provisional)} | ${cardList(deck.blocking)} |`,
      ),
    );
    if (population.unblock.length > 0) {
      out.push(
        '',
        `### Cards that unblock the most decks`,
        '',
        'Ranked by decks where the card is the only unmodeled card, then by decks where it is one of two. *(p)* marks a card with a provisional definition in review: accepting it is the cheaper fix.',
        '',
        '| Card | Only blocker | One of two | Decks blocked |',
        '| ---- | -----------: | ---------: | ------------: |',
        ...population.unblock
          .slice(0, SHOWN_UNBLOCK)
          .map(
            (row) =>
              `| ${row.name}${row.provisional ? ' *(p)*' : ''} | ${row.onlyBlocker} | ${row.oneOfTwo} | ${row.decks} |`,
          ),
      );
      if (population.unblock.length > SHOWN_UNBLOCK)
        out.push('', `${population.unblock.length - SHOWN_UNBLOCK} more cards in the JSON report.`);
    }
  }
  return `${out.join('\n')}\n`;
}
