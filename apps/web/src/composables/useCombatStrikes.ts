/**
 * MTGA-style attack animation: for every damage cue the server sends (ADR 0032 decision 8), the
 * striking permanent lunges toward its target and back. `PermanentChip.vue` reads its own entry by
 * permanent id and animates; this composable only decides *when* and *how far*, reusing the same
 * anchor registry the combat overlay draws lines from (§9.8.1). The cues say who hit what, so
 * nothing is inferred from board differences; damage dealt together (one combat damage step)
 * shares a group, and each later group starts once the one before has played.
 */
import { reactive } from 'vue';
import type { ObjectId, PresentationCue } from '@mtg/shared';
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
/** Later strike groups of a batch, waiting their turn. */
const pendingGroups: Array<ReturnType<typeof setTimeout>> = [];

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

  /** Call once per batch of cues. Caller skips this entirely under reduced motion. */
  function observeCues(cues: readonly PresentationCue[]): void {
    const groups = new Map<number, Array<{ source: ObjectId; target: string }>>();
    for (const cue of cues) {
      if (cue.kind !== 'damage' || cue.sourceId === null) continue;
      const list = groups.get(cue.group) ?? [];
      list.push({ source: cue.sourceId, target: cue.target.id });
      groups.set(cue.group, list);
    }
    [...groups.keys()]
      .sort((a, b) => a - b)
      .forEach((group, index) => {
        const strikesInGroup = groups.get(group) ?? [];
        const play = (): void => {
          for (const { source, target } of strikesInGroup) trigger(source, target);
        };
        if (index === 0) play();
        else pendingGroups.push(setTimeout(play, index * STRIKE_MS));
      });
  }

  function strikeFor(id: ObjectId): StrikeVector | undefined {
    return strikes.get(id);
  }

  return { observeCues, strikeFor };
}

/**
 * Clears every in-flight strike and every strike group still waiting, so nothing from one game
 * animates on the next. Called from `stores/game.ts`'s `gameStarted` handler.
 */
export function resetCombatStrikes(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const timer of pendingGroups.splice(0)) clearTimeout(timer);
  strikes.clear();
}
