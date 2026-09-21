/**
 * MTGA-style attack animation: diffs each freshly pushed board against the previous one and, for
 * every damage event attributable to a still-visible `attacking`/`blocking`/`blockedBy` pairing
 * (spectator.ts), records a vector for the striking permanent to lunge toward its target and back.
 * `PermanentChip.vue` reads its own entry by permanent id and animates; this composable only
 * decides *when* and *how far*, reusing the same anchor registry the combat overlay draws lines
 * from (§9.8.1). Presentation only, not a new source of truth: it infers "who hit what" from state
 * deltas rather than a dedicated damage event, so a non-combat damage source hitting a permanent
 * that happens to be attacking/blocking, or trample discounted through a blocker, can misattribute
 * — acceptable for board juice, not for anything the engine treats as authoritative.
 */
import { reactive } from 'vue';
import type { ObjectId, PlayerBoardState, PlayerId } from '@mtg/shared';
import { useBoardAnchors } from './useBoardAnchors';

export interface StrikeVector {
  dx: number;
  dy: number;
  key: number;
}

/** Exported so `PermanentChip.vue` can keep its cleanup timer and CSS animation duration in sync. */
export const STRIKE_MS = 520;

const MAX_TRAVEL_PX = 220;
const LUNGE_FACTOR = 0.72;

const strikes = reactive(new Map<ObjectId, StrikeVector>());
const timers = new Map<ObjectId, ReturnType<typeof setTimeout>>();
let prevDamage = new Map<ObjectId, number>();
let prevLife = new Map<PlayerId, number>();

export function useCombatStrikes() {
  const { anchorFor } = useBoardAnchors();

  function trigger(source: ObjectId, target: string): void {
    const from = anchorFor(source);
    const to = anchorFor(target);
    if (from === undefined || to === undefined) return;
    const rawDx = to.x + to.width / 2 - (from.x + from.width / 2);
    const rawDy = to.y + to.height / 2 - (from.y + from.height / 2);
    const dist = Math.hypot(rawDx, rawDy) || 1;
    const travel = Math.min(dist, MAX_TRAVEL_PX) * LUNGE_FACTOR;

    const existingTimer = timers.get(source);
    if (existingTimer !== undefined) clearTimeout(existingTimer);
    strikes.set(source, {
      dx: (rawDx / dist) * travel,
      dy: (rawDy / dist) * travel,
      key: (strikes.get(source)?.key ?? 0) + 1,
    });
    timers.set(
      source,
      setTimeout(() => {
        strikes.delete(source);
        timers.delete(source);
      }, STRIKE_MS),
    );
  }

  /** Call once per freshly pushed board. Caller skips this entirely under reduced motion. */
  function observe(state: PlayerBoardState): void {
    const battlefield = state.battlefield;
    const pending: Array<{ source: ObjectId; target: string }> = [];

    for (const victim of battlefield) {
      const before = prevDamage.get(victim.id) ?? victim.damageMarked;
      if (victim.damageMarked <= before) continue;
      if (victim.blocking !== null) {
        pending.push({ source: victim.blocking, target: victim.id });
      } else if (victim.attacking !== null) {
        for (const blockerId of victim.blockedBy)
          pending.push({ source: blockerId, target: victim.id });
      }
    }

    for (const seat of state.seats) {
      const before = prevLife.get(seat.seat) ?? seat.life;
      if (seat.life >= before) continue;
      for (const attacker of battlefield) {
        if (attacker.attacking === seat.seat && attacker.blockedBy.length === 0) {
          pending.push({ source: attacker.id, target: seat.seat });
        }
      }
    }

    prevDamage = new Map(battlefield.map((p) => [p.id, p.damageMarked]));
    prevLife = new Map(state.seats.map((s) => [s.seat, s.life]));

    for (const { source, target } of pending) trigger(source, target);
  }

  function strikeFor(id: ObjectId): StrikeVector | undefined {
    return strikes.get(id);
  }

  return { observe, strikeFor };
}

/**
 * Clears every in-flight strike and the previous-board baseline. Without this, a new game's very
 * first `observe()` diffs against the prior game's final board: `prevLife`/`prevDamage` are keyed
 * by seat/object id, and seat ids (`P1`..`P4`) are reused by every game. It happens to be inert
 * today — both comparisons (`damageMarked <=`, `life >=`) treat a fresh game's floor values (0
 * damage, starting life) as "no change" against almost any leftover — but that's incidental to
 * the comparison directions, not a guarantee, so a new game gets a clean baseline explicitly
 * rather than relying on it. Called from `stores/game.ts`'s `gameStarted` handler.
 */
export function resetCombatStrikes(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  strikes.clear();
  prevDamage = new Map();
  prevLife = new Map();
}
