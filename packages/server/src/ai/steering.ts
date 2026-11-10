/**
 * Strategist knobs for the bot-led tactician (ADR 0039): reading them out of a model answer, and
 * deciding when the table has moved enough that a seat's knobs are worth asking for again.
 */

import type { BotSteering, PlayerView } from '@mtg/shared';

const MAX_NAMES = 8;

function names(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
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

/**
 * A coarse fingerprint of the public table, for `strategistReplan: 'onChange'`. Buckets are wide
 * on purpose: a land drop or a 2/2 should not cost a model call, a board wipe, a new big threat,
 * a big life swing, a commander arriving or a player dying should.
 */
export function steeringSignature(view: PlayerView): string {
  const seats = [view.seat, ...view.opponents.map((o) => o.seat)];
  const lifeOf = (seat: string): number =>
    seat === view.seat ? view.life : (view.opponents.find((o) => o.seat === seat)?.life ?? 0);
  const commanderNames = new Set([
    ...view.commanders.map((c) => c.name),
    ...view.opponents.flatMap((o) => o.commanders.map((c) => c.name)),
  ]);
  return seats
    .map((seat) => {
      const life = lifeOf(seat);
      if (life <= 0) return `${seat}:out`;
      const permanents = view.battlefield.filter((p) => p.controller === seat);
      const creatures = permanents.filter((p) => p.power !== undefined && p.power !== null);
      const power = creatures.reduce((sum, p) => sum + Math.max(0, p.power ?? 0), 0);
      const nonland = permanents.filter((p) => !(p.typeLine ?? '').includes('Land')).length;
      const commanderOut = permanents.some((p) => commanderNames.has(p.name));
      return [
        seat,
        Math.floor(life / 10),
        Math.floor(power / 10),
        Math.floor(nonland / 6),
        commanderOut ? 'C' : '-',
      ].join(':');
    })
    .join('|');
}
