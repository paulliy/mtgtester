/**
 * Watches a life total and returns 'damage' | 'heal' | null for ~0.8-0.9s after it changes, so a
 * seat's life chip can flash red/green (design handoff: board/player view overhaul). Thin
 * wrappers over `useBoardFlash`/`useBoardFlashByKey` — the same watch-diff-timeout shape reused
 * for damage marks, tapping, and other board-change feedback (§9.8).
 */
import { useBoardFlash, useBoardFlashByKey } from './useBoardFlash';

function classifyLife(prev: number, next: number): 'damage' | 'heal' | null {
  if (next === prev) return null;
  return next < prev ? 'damage' : 'heal';
}

export function useLifeFlash(life: () => number) {
  // Starts `null` on first read — the initial board snapshot isn't a life change to react to.
  return useBoardFlash(life, classifyLife);
}

/** Same idea as {@link useLifeFlash}, keyed by seat — for a v-for of opponents rather than one. */
export function useLifeFlashBySeat(seats: () => Array<{ seat: string; life: number }>) {
  return useBoardFlashByKey(
    () => seats().map(({ seat, life }) => ({ key: seat, value: life })),
    classifyLife,
  );
}
