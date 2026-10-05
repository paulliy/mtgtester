import type { EnginePlayerConfig } from '@mtg/engine';
import type {
  GameReportDecklist,
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

/** Consecutive copies collapse to "N Name"; order is kept. */
function collapse(cards: readonly OracleCard[]): string[] {
  const lines: Array<{ name: string; count: number }> = [];
  for (const card of cards) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.name === card.name) last.count += 1;
    else lines.push({ name: card.name, count: 1 });
  }
  return lines.map(({ name, count }) => `${count} ${name}`);
}

/**
 * The deck exactly as the engine received it, by role. The library keeps its configured order
 * rather than being sorted, because the seeded opening shuffle starts from it: a sorted list does
 * not reproduce. The companion stays its own field — folded into the list it would read as the
 * first library card, and a re-import would put it in the main deck.
 */
export function orderedDecklist(config: EnginePlayerConfig): GameReportDecklist {
  return {
    commanders: config.commanders.map((card) => card.name),
    companion: config.companion?.name ?? null,
    library: collapse(config.cards),
  };
}

/**
 * "Divide 3 damage: 2 to Wall of Omens, 1 to Goblin" — a submitted combat-damage split. The
 * decision's own option text names a preset the split overrides, so it must not stand in for it.
 */
export function describeSubmittedSplit(
  amount: number | undefined,
  split: Readonly<Record<string, number>>,
  nameOf: (id: string) => string,
): string {
  const parts = Object.entries(split)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${n} to ${nameOf(id)}`);
  const total = amount ?? Object.values(split).reduce((sum, n) => sum + n, 0);
  return `Divide ${total} damage: ${parts.length > 0 ? parts.join(', ') : 'none assigned'}`;
}

/** The public zones a decision's targets can name — battlefield, stack and graveyards. */
export interface PublicZones {
  battlefield: ReadonlyArray<{ id: string; name: string }>;
  stack: ReadonlyArray<{ id: string; description: string; card?: { name: string } | null }>;
  players: ReadonlyArray<{ graveyard: ReadonlyArray<{ id: string; name: string }> }>;
}

/**
 * The names of the ids a decision referred to, read from public zones only (a hand or face-down
 * card is never named). Read when the decision is made, not when the report is built: by then a
 * blocker a combat split was dealt to has usually died and left the battlefield, and a targeted
 * spell has resolved. An id found nowhere — a player seat — names itself.
 */
export function publicNames(zones: PublicZones, ids: readonly string[]): Record<string, string> {
  const nameOf = (id: string): string => {
    const permanent = zones.battlefield.find((candidate) => candidate.id === id);
    if (permanent !== undefined) return permanent.name;
    const stacked = zones.stack.find((candidate) => candidate.id === id);
    if (stacked !== undefined) return stacked.card?.name ?? stacked.description;
    for (const player of zones.players) {
      const card = player.graveyard.find((candidate) => candidate.id === id);
      if (card !== undefined) return card.name;
    }
    return id;
  };
  return Object.fromEntries(ids.map((id) => [id, nameOf(id)]));
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
