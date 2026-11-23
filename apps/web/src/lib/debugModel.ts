/**
 * The Debug page's view model: plain functions from the server's debug rows to what the page
 * prints (rounds, engine log lines, AI call rows), so the rules are tested apart from the layout.
 */
import type { GameListItem } from '@mtg/shared';
import { seatLetter } from './batchModel';

export interface DebugEventRow {
  sequence: number;
  turn: number;
  category: string;
  message: string;
  data_json: string | null;
}
export interface GameEventRow {
  sequence: number;
  turn: number | null;
  event_type: string | null;
  payload_json: string | null;
}
export interface AiCallRow {
  sequence: number;
  seat: number | null;
  model: string | null;
  prompt_tokens: number | null;
  response_tokens: number | null;
  was_retry: number | null;
  was_fallback: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  source: string | null;
  turn: number | null;
  request_json: string | null;
  response_json: string | null;
}
export interface DebugPayload {
  game: Record<string, unknown> | null;
  events: GameEventRow[];
  debugEvents: DebugEventRow[];
  aiCalls: AiCallRow[];
}

/** Round 0 is the setup (mulligans, opening hands); round 1 is the first turn of every seat. */
export function roundOf(turn: number, seats: number): number {
  return turn <= 0 ? 0 : Math.floor((turn - 1) / Math.max(1, seats)) + 1;
}
export function roundLabel(round: number): string {
  return round === 0 ? 'Setup' : `R${round}`;
}

/** The categories that read as a game log. The rest (priority passes, state-based checks, legal-action lists, decision prompts) are noise at this size. */
const READABLE = new Set(['engine', 'zoneChange', 'stack', 'combat', 'effect']);
export function isReadable(entry: DebugEventRow): boolean {
  return (
    READABLE.has(entry.category) || (entry.category === 'turn' && /^--- turn /.test(entry.message))
  );
}

/** The first seat a message names (`P3 casts ...`), as its letter; a dash when none. */
export function messageSeat(message: string): string {
  const match = /\bP([1-9])\b/.exec(message);
  return match === null ? '—' : seatLetter(`P${match[1]}`);
}

export interface LogLine {
  key: string;
  round: number;
  seat: string;
  text: string;
  halt: boolean;
}

/** The game's halt, from its `gameOver` event, so the log ends on why the game stopped. */
export function haltLine(events: readonly GameEventRow[], seats: number): LogLine | null {
  for (const event of events) {
    if (event.event_type !== 'gameOver' || event.payload_json === null) continue;
    try {
      const payload = JSON.parse(event.payload_json) as { halted?: boolean; haltReason?: unknown };
      if (payload.halted !== true) return null;
      const reason = typeof payload.haltReason === 'string' ? payload.haltReason : 'unknown reason';
      return {
        key: `halt-${event.sequence}`,
        round: roundOf(event.turn ?? 0, seats),
        seat: '—',
        text: `Halt: ${reason}. Game stopped.`,
        halt: true,
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function logLines(data: DebugPayload, seats: number): LogLine[] {
  const lines: LogLine[] = data.debugEvents.filter(isReadable).map((entry) => ({
    key: `d-${entry.sequence}`,
    round: roundOf(entry.turn, seats),
    seat: messageSeat(entry.message),
    text: entry.message,
    halt: false,
  }));
  const halt = haltLine(data.events, seats);
  return halt === null ? lines : [...lines, halt];
}

export interface CallLine {
  sequence: number;
  round: number;
  seat: string;
  decision: string;
  tokens: number;
  noResponse: boolean;
  latencyMs: number | null;
  row: AiCallRow;
}

function parse(json: string | null): Record<string, unknown> | null {
  if (json === null || json === '') return null;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `declareAttackers` → "Declare attackers". */
export function humanize(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words === '' ? words : words[0]!.toUpperCase() + words.slice(1);
}

export function decisionLabel(call: AiCallRow): string {
  const request = parse(call.request_json);
  const type = request?.['decisionType'];
  if (typeof type === 'string' && type !== '') return humanize(type);
  return call.source === null || call.source === '' ? 'Decision' : humanize(call.source);
}

/** A call that produced nothing: a fallback answer, or a row with no stored response. */
export function hasNoResponse(call: AiCallRow): boolean {
  return call.was_fallback === 1 || parse(call.response_json) === null;
}

export function callLines(calls: readonly AiCallRow[], seats: number): CallLine[] {
  return calls.map((row) => {
    const request = parse(row.request_json);
    const turn = row.turn ?? (typeof request?.['turn'] === 'number' ? request['turn'] : 0);
    return {
      sequence: row.sequence,
      round: roundOf(turn, seats),
      seat: row.seat === null || row.seat <= 0 ? '—' : seatLetter(`P${row.seat}`),
      decision: decisionLabel(row),
      tokens: (row.prompt_tokens ?? 0) + (row.response_tokens ?? 0),
      noResponse: hasNoResponse(row),
      latencyMs: row.latency_ms,
      row,
    };
  });
}

export function compactTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k tok` : `${count} tok`;
}
export function latencyLabel(ms: number | null): string {
  if (ms === null || ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Token bar width, as a share of the busiest call in the game. */
export function tokenShare(tokens: number, most: number): number {
  return most <= 0 ? 0 : Math.min(1, tokens / most);
}

/** The rounds that have any data, in order, for the filter chips. */
export function roundsWithData(logs: readonly LogLine[], calls: readonly CallLine[]): number[] {
  return [...new Set([...logs.map((line) => line.round), ...calls.map((call) => call.round)])].sort(
    (a, b) => a - b,
  );
}

/** Pretty-prints stored JSON for the request and response panes; leaves anything else as it is. */
export function prettyJson(text: string | null): string {
  if (text === null || text === '') return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** One option of the Game selector: "Nov 23, 19:32 · seed dbg-1:s1:g1 · finished · winner A". */
export function gameOptionLabel(game: GameListItem, live: boolean): string {
  const stamp = game.startedAt === null ? null : new Date(game.startedAt);
  const when =
    stamp === null || Number.isNaN(stamp.getTime())
      ? 'undated'
      : stamp.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  const result =
    game.winnerSeat === null ? 'no winner' : `winner ${seatLetter(`P${game.winnerSeat}`)}`;
  return [live ? 'live' : null, when, `seed ${game.seed}`, game.status ?? 'unknown', result]
    .filter((part) => part !== null)
    .join(' · ');
}

/** The engine build under the title: a short commit, marked when the tree was dirty. */
export function buildLabel(commit: unknown, dirty: unknown): string {
  if (typeof commit !== 'string' || commit === '') return 'engine build not recorded';
  return `engine ${commit.slice(0, 8)}${dirty === 1 ? ' (dirty tree)' : ''}`;
}
