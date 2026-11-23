/**
 * The Batch runs page's view model: plain functions from the server's batch types to the text and
 * numbers the page prints, so the page holds layout and the rules here are tested on their own.
 */
import type {
  BatchAggregate,
  BatchGameSummary,
  BatchProgress,
  BatchStatus,
  PlayerId,
} from '@mtg/shared';

/** A fair share of wins at a four-player table. */
export const FAIR_SHARE_PERCENT = 25;
export const SEAT_LETTERS = ['A', 'B', 'C', 'D'] as const;
export type SeatLetter = (typeof SEAT_LETTERS)[number];

/** `P1` is seat A, the seat that moves first. Anything else prints as given. */
export function seatLetter(seat: PlayerId | string | null): string {
  if (seat === null) return '—';
  const match = /^P(\d+)$/.exec(seat);
  const letter = match === null ? undefined : SEAT_LETTERS[Number(match[1]) - 1];
  return letter ?? seat;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The run's own name, else its scenario names, else a neutral label. */
export function runLabel(name: string | null, scenarioNames: readonly string[]): string {
  const own = name?.trim() ?? '';
  if (own !== '') return own;
  const names = scenarioNames.map((item) => item.trim()).filter((item) => item !== '');
  return names.length === 0 ? 'Untitled run' : names.join(' + ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "21 Nov, 21:40" in the viewer's time zone; empty for an unreadable date. */
export function formatWhen(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]}, ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export type StatusTone = 'finished' | 'running' | 'failed' | 'cancelled';
export function statusTag(status: BatchStatus): { label: string; tone: StatusTone } {
  switch (status) {
    case 'completed':
      return { label: 'Finished', tone: 'finished' };
    case 'running':
      return { label: 'Running', tone: 'running' };
    case 'queued':
      return { label: 'Queued', tone: 'running' };
    case 'failed':
      return { label: 'Failed', tone: 'failed' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'cancelled' };
  }
}
export function isActive(status: BatchStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function fraction(done: number, total: number): number {
  return total <= 0 ? 0 : Math.min(1, Math.max(0, done / total));
}

/** "1.9M", "12.3K", "420". */
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/** The AI tile's detail line: calls and tokens, or "calls" alone when none were made. */
export function aiDetail(ai: BatchAggregate['ai']): string {
  if (ai.calls === 0) return 'calls';
  return `${plural(ai.calls, 'call')} · ${compactCount(ai.promptTokens + ai.responseTokens)} tokens`;
}

export interface SeatRow {
  letter: SeatLetter;
  wins: number;
  /** Share of finished games, 0 to 1. */
  share: number;
  averagePosition: number | null;
}
/** One row per seat, in seat order, whether or not it won. */
export function seatRows(aggregate: BatchAggregate): SeatRow[] {
  return SEAT_LETTERS.map((letter, index) => {
    const seat: PlayerId = `P${index + 1}`;
    const wins = aggregate.winsBySeat.find((entry) => entry.seat === seat)?.wins ?? 0;
    const averagePosition =
      aggregate.placementsBySeat.find((entry) => entry.seat === seat)?.averagePosition ?? null;
    return { letter, wins, share: fraction(wins, aggregate.gamesFinished), averagePosition };
  });
}
export function seatTip(row: SeatRow, finished: number): string {
  const finish =
    row.averagePosition === null ? '' : `, average finish ${row.averagePosition.toFixed(1)}`;
  return `Seat ${row.letter}: ${plural(row.wins, 'win')} of ${finished}${finish}`;
}

/** Wins by seat for the split bar: only seats that won, in seat order. */
export function splitSegments(
  aggregate: BatchAggregate,
): Array<{ letter: SeatLetter; wins: number }> {
  return seatRows(aggregate)
    .filter((row) => row.wins > 0)
    .map((row) => ({ letter: row.letter, wins: row.wins }));
}

export type GameFilter = 'all' | 'failed';
export interface GameRow {
  gameId: string;
  key: string;
  index: string;
  scenario: string;
  seed: string;
  /** A seat letter, "×" for a game that stopped, "·" while it is still going. */
  winner: string;
  turns: string;
  order: string;
  failed: boolean;
  running: boolean;
}

const isEnded = (game: BatchGameSummary): boolean =>
  game.status !== 'running' && game.status !== 'queued';
export const isFailedGame = (game: BatchGameSummary): boolean =>
  isEnded(game) && game.status !== 'finished';

function finishOrder(game: BatchGameSummary): string {
  const placed = game.standings
    .filter((item) => item.position !== null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return placed.length === 0 ? '—' : placed.map((item) => seatLetter(item.seat)).join(' · ');
}

export function gameRows(games: readonly BatchGameSummary[], filter: GameFilter): GameRow[] {
  const rows = games.map((game, position): GameRow => {
    const failed = isFailedGame(game);
    const running = !isEnded(game);
    const turns =
      game.turnCount !== null
        ? String(game.turnCount)
        : game.lastRecordedTurn !== null
          ? String(game.lastRecordedTurn)
          : '—';
    return {
      gameId: game.gameId,
      key: game.gameId,
      index: String(position + 1).padStart(3, '0'),
      scenario: game.scenarioName,
      seed: game.seed,
      winner: failed ? '×' : running ? '·' : seatLetter(game.winnerSeat),
      turns,
      order: failed
        ? (game.failureReason ?? `Stopped (${game.status})`)
        : running
          ? 'In progress'
          : finishOrder(game),
      failed,
      running,
    };
  });
  return filter === 'failed' ? rows.filter((row) => row.failed) : rows;
}

/** The run list's progress line, "35 / 35". */
export function doneText(progress: Pick<BatchProgress, 'completedGames' | 'totalGames'>): string {
  return `${progress.completedGames} / ${progress.totalGames}`;
}
