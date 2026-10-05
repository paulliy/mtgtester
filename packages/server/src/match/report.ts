import type { EnginePlayerConfig } from '@mtg/engine';
import type {
  GameReportDeckSource,
  OracleCard,
  PlayerId,
  SeatSource,
  SpectatorLogLine,
} from '@mtg/shared';

/** The seat source a session was started from; Card Test Lab seats have no setup source. */
export type ReportSeatSource = SeatSource | { kind: 'cardTestScenario' };

/** How many of the player's newest log lines a report carries. */
export const REPORT_LOG_LINES = 40;

/**
 * The deck exactly as the engine received it — commanders, companion, then the library in its
 * configured order — with consecutive copies collapsed to "N Name". Order is kept rather than
 * sorted because the seeded opening shuffle starts from it: a sorted list does not reproduce.
 */
export function orderedDecklist(config: EnginePlayerConfig): string[] {
  const cards: OracleCard[] = [
    ...config.commanders,
    ...(config.companion ? [config.companion] : []),
    ...config.cards,
  ];
  const lines: Array<{ name: string; count: number }> = [];
  for (const card of cards) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.name === card.name) last.count += 1;
    else lines.push({ name: card.name, count: 1 });
  }
  return lines.map(({ name, count }) => `${count} ${name}`);
}

/**
 * A seat's deck source for the report. `reveal` is false for an opponent while the game is live:
 * an imported URL or pasted list identifies their cards, so only the kind survives. A generator
 * seed and a snapshot id are what the player already chose or saw at setup.
 */
export function reportDeckSource(
  source: ReportSeatSource | undefined,
  seatIndex: number,
  gameSeed: string,
  reveal: boolean,
): GameReportDeckSource {
  if (source === undefined || source.kind === 'cardTestScenario')
    return { kind: 'cardTestScenario' };
  switch (source.kind) {
    case 'pool':
      // The same default `setupSeats` applies, so the report names the seed actually used.
      return { kind: 'pool', seed: source.seed ?? `${gameSeed}-seat${seatIndex + 1}` };
    case 'snapshot':
      return { kind: 'snapshot', snapshotId: source.snapshotId };
    case 'url':
      return { kind: 'url', url: reveal ? source.url : null };
    case 'plaintext':
      return { kind: 'plaintext' };
  }
}

/** "T12 P3 Cast Lightning Bolt" — one log line as the action log shows it. */
export function reportLogLine(line: SpectatorLogLine): string {
  return `T${line.turn}${line.actorSeat === null ? '' : ` ${line.actorSeat}`} ${line.text}`;
}

/** The seat a report may reveal everything for: the player's own, or any once the game is over. */
export function mayRevealSeat(seat: PlayerId, humanSeat: PlayerId, over: boolean): boolean {
  return over || seat === humanSeat;
}
