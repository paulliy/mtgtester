/**
 * The Stats page's data and the small pure functions behind it. The shapes mirror the server's
 * `GET /api/stats` response (`packages/server/src/db/stats.ts`); `normalizeReport` also accepts the
 * older `{ decks }`-only body, so a mocked or older server still renders.
 */

export interface DeckStatistic {
  deckSnapshotId: string;
  name: string;
  generated: boolean;
  commanders: string[];
  colorIdentity: string[];
  archetypeTag: string;
  gamesPlayed: number;
  wins: number;
  winRate: number;
  finishDistribution: [number, number, number, number];
  lastGameId: string | null;
  averageFinish: number | null;
  averageGameLength: number | null;
  averageMulligans: number;
  mulliganDistribution: Array<{ mulligans: number; games: number }>;
  eliminationCauses: Array<{ reason: string; label: string; count: number }>;
  lossesTo: Array<{
    commanders: string[];
    colorIdentity: string[];
    archetypeTag: string;
    count: number;
  }>;
}

export interface StatsSummary {
  finishedGames: number;
  generatedGames: number;
  decksTracked: number;
  averageTurns: number | null;
  mostCommonEnd: { reason: string; label: string; share: number } | null;
}

export interface StatsReport {
  scope: StatsScopeName;
  batchId: string | null;
  decks: DeckStatistic[];
  summary: StatsSummary;
  matchups: Array<{ winner: string; beaten: string; games: number }>;
}

export type StatsScopeName = 'all' | 'batch' | 'mine';
export type StandingsSort = 'win' | 'finish' | 'games';

/** What the wire may omit: everything but `decks` (older servers, mocked responses). */
type Wire = Partial<Omit<StatsReport, 'decks'>> & {
  decks: Array<Partial<DeckStatistic> & Pick<DeckStatistic, 'deckSnapshotId' | 'name'>>;
};

export function normalizeReport(wire: Wire): StatsReport {
  const decks: DeckStatistic[] = wire.decks.map((deck) => ({
    generated: false,
    commanders: [],
    colorIdentity: [],
    archetypeTag: '',
    gamesPlayed: 0,
    wins: 0,
    winRate: 0,
    finishDistribution: [0, 0, 0, 0],
    lastGameId: null,
    averageFinish: null,
    averageGameLength: null,
    averageMulligans: 0,
    mulliganDistribution: [],
    eliminationCauses: [],
    lossesTo: [],
    ...deck,
  }));
  const played = decks.filter((deck) => deck.gamesPlayed > 0);
  const own = played.filter((deck) => !deck.generated);
  const lengthGames = played.filter((deck) => deck.averageGameLength !== null);
  const lengthWeight = lengthGames.reduce((sum, deck) => sum + deck.gamesPlayed, 0);
  return {
    scope: wire.scope ?? 'all',
    batchId: wire.batchId ?? null,
    decks,
    matchups: wire.matchups ?? [],
    summary: wire.summary ?? {
      finishedGames: Math.max(0, ...played.map((deck) => deck.gamesPlayed)),
      generatedGames: 0,
      decksTracked: own.length,
      averageTurns:
        lengthWeight === 0
          ? null
          : lengthGames.reduce(
              (sum, deck) => sum + (deck.averageGameLength ?? 0) * deck.gamesPlayed,
              0,
            ) / lengthWeight,
      mostCommonEnd: null,
    },
  };
}

const ROMAN: Array<[number, string]> = [
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];
export function romanNumeral(value: number): string {
  let rest = Math.max(1, Math.floor(value));
  let out = '';
  for (const [size, glyph] of ROMAN)
    while (rest >= size) {
      out += glyph;
      rest -= size;
    }
  return out;
}

/** An unnamed deck (every generated one) is named by its snapshot id; head it by its commanders. */
export function deckHeading(deck: DeckStatistic): string {
  if (deck.name !== deck.deckSnapshotId && deck.name.trim() !== '') return deck.name;
  return deck.commanders.length > 0 ? deck.commanders.join(' / ') : 'Unnamed deck';
}

export function sortDecks(decks: readonly DeckStatistic[], by: StandingsSort): DeckStatistic[] {
  const finish = (deck: DeckStatistic): number => deck.averageFinish ?? Number.POSITIVE_INFINITY;
  return [...decks].sort((a, b) => {
    const order =
      by === 'win'
        ? b.winRate - a.winRate
        : by === 'finish'
          ? finish(a) - finish(b)
          : b.gamesPlayed - a.gamesPlayed;
    if (order !== 0 && !Number.isNaN(order)) return order;
    return b.gamesPlayed - a.gamesPlayed || deckHeading(a).localeCompare(deckHeading(b));
  });
}

export const HEAT_STEPS = 6;

/**
 * Which of the six shades a matchup count gets, binned over the smallest and largest off-diagonal
 * count. When every cell is equal there is nothing to compare, so all take the palest shade.
 */
export function heatStep(count: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(
    HEAT_STEPS - 1,
    Math.max(0, Math.round(((count - min) / (max - min)) * (HEAT_STEPS - 1))),
  );
}

/** Mulligan counts folded into "kept seven", 1, 2 and "3 or more". */
export function mulliganBuckets(
  distribution: ReadonlyArray<{ mulligans: number; games: number }>,
): Array<{ label: string; count: number }> {
  const counts = [0, 0, 0, 0];
  for (const entry of distribution) {
    const slot = Math.min(3, Math.max(0, entry.mulligans));
    counts[slot] = (counts[slot] ?? 0) + entry.games;
  }
  const labels = ['Kept seven', '1 mulligan', '2 mulligans', '3 or more'];
  return labels.map((label, index) => ({ label, count: counts[index] ?? 0 }));
}

export interface BarRow {
  label: string;
  count: number;
  tip: string;
}

/** The first `rows` entries, padded with empty rows so a panel keeps its height between decks. */
export function padRows(rows: BarRow[], minimum: number): BarRow[] {
  const padded = [...rows];
  while (padded.length < minimum) padded.push({ label: '—', count: 0, tip: '' });
  return padded;
}

export function causeRows(deck: DeckStatistic): { rows: BarRow[]; total: number } {
  const total = deck.eliminationCauses.reduce((sum, entry) => sum + entry.count, 0);
  const rows = [...deck.eliminationCauses]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((entry) => ({
      label: entry.label,
      count: entry.count,
      tip: `${entry.count} of ${total} losses`,
    }));
  return { rows: padRows(rows, 3), total };
}

export function lossesToRows(deck: DeckStatistic, total: number): BarRow[] {
  const rows = [...deck.lossesTo]
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((entry) => {
      const label = entry.commanders.join(' / ') || entry.archetypeTag || 'Unknown deck';
      return { label, count: entry.count, tip: `${label} won ${entry.count} of ${total} losses` };
    });
  return padRows(rows, 3);
}

/** The first letter lowered, so "Life total reached 0" reads under a figure as a unit. */
export function lowerFirst(text: string): string {
  return text === '' ? text : text.charAt(0).toLowerCase() + text.slice(1);
}
