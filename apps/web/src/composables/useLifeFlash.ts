/**
 * Flashes a seat's life chip red or green for ~0.9s when its life total changes (design handoff:
 * board/player view overhaul). Driven by the server's `lifeChange` cues (ADR 0032 decision 8),
 * which carry the real delta, so the browser no longer watches totals and guesses: the store
 * hands every batch's cues to `applyLifeCues`, and components read the flash by seat.
 *
 * A module-level registry, like `useCombatStrikes`, because the store and every seat panel share
 * it; `resetLifeFlashes` clears it for a new game.
 */
import { computed, reactive } from 'vue';
import type { PresentationCue } from '@mtg/shared';

export type LifeFlash = 'damage' | 'heal' | null;

export const LIFE_FLASH_MS = 900;

const flashes = reactive<Record<string, LifeFlash>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Flash each seat whose life changed in this batch. */
export function applyLifeCues(cues: readonly PresentationCue[]): void {
  for (const cue of cues) {
    if (cue.kind !== 'lifeChange' || cue.delta === 0) continue;
    const seat = cue.player;
    const existing = timers.get(seat);
    if (existing !== undefined) clearTimeout(existing);
    flashes[seat] = cue.delta < 0 ? 'damage' : 'heal';
    timers.set(
      seat,
      setTimeout(() => {
        flashes[seat] = null;
        timers.delete(seat);
      }, LIFE_FLASH_MS),
    );
  }
}

export function resetLifeFlashes(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const seat of Object.keys(flashes)) delete flashes[seat];
}

/** The flash for one seat. */
export function useLifeFlash(seat: () => string | undefined) {
  return computed<LifeFlash>(() => {
    const id = seat();
    return id === undefined ? null : (flashes[id] ?? null);
  });
}

/** Every seat's flash, keyed by seat — for a v-for of opponents. */
export function useLifeFlashBySeat(): Readonly<Record<string, LifeFlash>> {
  return flashes;
}
