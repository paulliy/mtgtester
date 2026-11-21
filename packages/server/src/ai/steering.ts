/**
 * Strategist knobs for the bot-led tactician (ADR 0039): reading them out of a model answer, and
 * deciding when the table has moved enough that a seat's knobs are worth asking for again.
 */

import type { BotSteering, PlayerView } from '@mtg/shared';

const MAX_NAMES = 8;

function names(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  // An empty list is an instruction: clear the knob (knobs persist, `knob-persistence.ts`).
  if (raw.length === 0) return [];
  const out = raw
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .map((n) => n.trim().slice(0, 120))
    .slice(0, MAX_NAMES);
  return out.length > 0 ? out : undefined;
}

/**
 * Keep only well-formed knobs. Seats that are not opponents of `seat` are dropped from
 * `targetOrder`; numbers are clamped to their documented ranges. Returns null when nothing usable
 * is left, so a malformed answer leaves the previous knobs in place rather than resetting them.
 */
export function cleanSteering(raw: unknown, opponents: readonly string[]): BotSteering | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: BotSteering = {};
  if (typeof r['aggression'] === 'number' && Number.isFinite(r['aggression'])) {
    out.aggression = Math.min(1, Math.max(0, r['aggression']));
  }
  if (Array.isArray(r['targetOrder'])) {
    const order = r['targetOrder'].filter(
      (s): s is string => typeof s === 'string' && opponents.includes(s),
    );
    if (order.length > 0) out.targetOrder = [...new Set(order)];
    else if (r['targetOrder'].length === 0) out.targetOrder = [];
  }
  const prioritize = names(r['prioritize']);
  if (prioritize !== undefined) out.prioritize = prioritize;
  const hold = names(r['hold']);
  if (hold !== undefined) out.hold = hold;
  if (typeof r['holdUpMana'] === 'number' && Number.isFinite(r['holdUpMana'])) {
    out.holdUpMana = Math.min(20, Math.max(0, Math.round(r['holdUpMana'])));
  }
  if (typeof r['avoidOverextending'] === 'boolean') {
    out.avoidOverextending = r['avoidOverextending'];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** One seat's public position, as `tableSnapshot` records it. */
export interface SeatSnapshot {
  life: number;
  power: number;
  nonland: number;
  commanderOut: boolean;
}

export type TableSnapshot = Record<string, SeatSnapshot>;

/** The public numbers `tableChanged` compares, for every seat the view shows. */
export function tableSnapshot(view: PlayerView): TableSnapshot {
  const commanderNames = new Set([
    ...view.commanders.map((c) => c.name),
    ...view.opponents.flatMap((o) => o.commanders.map((c) => c.name)),
  ]);
  const seats: Array<[string, number]> = [
    [view.seat, view.life],
    ...view.opponents.map((o): [string, number] => [o.seat, o.life]),
  ];
  const out: TableSnapshot = {};
  for (const [seat, life] of seats) {
    const permanents = view.battlefield.filter((p) => p.controller === seat);
    const creatures = permanents.filter((p) => p.power !== undefined && p.power !== null);
    out[seat] = {
      life,
      power: creatures.reduce((sum, p) => sum + Math.max(0, p.power ?? 0), 0),
      nonland: permanents.filter((p) => !(p.typeLine ?? '').includes('Land')).length,
      commanderOut: permanents.some((p) => commanderNames.has(p.name)),
    };
  }
  return out;
}

/** How far a number must move before the table counts as changed. */
const LIFE_SWING = 10;
const POWER_SWING = 8;
const NONLAND_SWING = 4;

/**
 * Which table changes wake the strategist (`AI_STRATEGIST_WAKE_RULE`).
 *
 * - `table-v1` (ADR 0039): any seat's life, power or nonland count moving past its threshold, in
 *   either direction, any commander arriving or leaving, or a player dying.
 * - `table-v2` (hill-climb S7): the same thresholds, minus the changes the seat's knobs already
 *   expected. The seat's own board growing or its own commander arriving is mostly the seat
 *   carrying out its own knobs, so only its own losses wake it (a wipe, a removed commander, a
 *   life swing). No commander arriving wakes it: every commander is public from turn 0, in the
 *   prompt with its text and cast count, so its arrival is expected, and a big body still shows
 *   in its seat's power and permanents. A commander leaving, which nobody can schedule, still
 *   wakes. In the hill-climb census, commander arrivals were 30% of all wakes.
 */
export type WakeRule = 'table-v1' | 'table-v2';

export const WAKE_RULES: readonly WakeRule[] = ['table-v1', 'table-v2'];

interface WakeOptions {
  /** The seat whose knobs are being judged; its own changes are read as its own under v2. */
  self?: string;
  rule?: WakeRule;
}

/**
 * Whether the table has moved enough since `before` to be worth new knobs, for
 * `strategistReplan: 'onChange'`. Measured as distance from when the knobs were set, not as
 * bucket boundaries, so a 1-point change never triggers a call by crossing a line: a board wipe,
 * a big new threat, a large life swing, a commander arriving or leaving, or a player dying does.
 */
export function tableChanged(
  before: TableSnapshot,
  now: TableSnapshot,
  options: WakeOptions = {},
): boolean {
  return tableChangeReasons(before, now, options).length > 0;
}

/**
 * What moved since `before`, in words (`P2 life`, `P3 power`, `P4 eliminated`): the changes that
 * would wake the strategist under `onChange`. ADR 0045 records them beside each tactician request.
 * Without `rule` this is `table-v1`, as it was before `WakeRule` existed.
 */
export function tableChangeReasons(
  before: TableSnapshot,
  now: TableSnapshot,
  options: WakeOptions = {},
): string[] {
  const v2 = options.rule === 'table-v2';
  const reasons: string[] = [];
  for (const [seat, was] of Object.entries(before)) {
    const is = now[seat];
    if (is === undefined) {
      reasons.push(`${seat} gone`);
      continue;
    }
    if (was.life > 0 !== is.life > 0) {
      reasons.push(`${seat} ${is.life > 0 ? 'back' : 'eliminated'}`);
      continue;
    }
    if (is.life <= 0) continue;
    const own = v2 && seat === options.self;
    if (Math.abs(is.life - was.life) >= LIFE_SWING) reasons.push(`${seat} life`);
    const power = is.power - was.power;
    if (Math.abs(power) >= Math.max(POWER_SWING, was.power / 2) && !(own && power > 0))
      reasons.push(`${seat} power`);
    const nonland = is.nonland - was.nonland;
    if (Math.abs(nonland) >= NONLAND_SWING && !(own && nonland > 0))
      reasons.push(`${seat} permanents`);
    if (is.commanderOut !== was.commanderOut && !(v2 && is.commanderOut))
      reasons.push(`${seat} commander`);
  }
  return reasons;
}
