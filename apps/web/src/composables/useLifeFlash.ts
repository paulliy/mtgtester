/**
 * Watches a life total and returns 'damage' | 'heal' | null for ~0.8-0.9s after it changes, so a
 * seat's life chip can flash red/green (design handoff: board/player view overhaul). Starts
 * `null` on first read — the initial board snapshot isn't a life change to react to.
 */
import { reactive, ref, watch } from 'vue';

export function useLifeFlash(life: () => number) {
  const flash = ref<'damage' | 'heal' | null>(null);
  let previous = life();
  let timer: ReturnType<typeof setTimeout> | null = null;

  watch(life, (next) => {
    const delta = next - previous;
    previous = next;
    if (delta === 0) return;
    if (timer !== null) clearTimeout(timer);
    flash.value = delta < 0 ? 'damage' : 'heal';
    timer = setTimeout(() => {
      flash.value = null;
      timer = null;
    }, 900);
  });

  return flash;
}

/** Same idea as {@link useLifeFlash}, keyed by seat — for a v-for of opponents rather than one. */
export function useLifeFlashBySeat(seats: () => Array<{ seat: string; life: number }>) {
  const flashes = reactive<Record<string, 'damage' | 'heal' | null>>({});
  const previous = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  watch(
    seats,
    (current) => {
      for (const { seat, life } of current) {
        const prior = previous.get(seat);
        previous.set(seat, life);
        if (prior === undefined || prior === life) continue;
        const existing = timers.get(seat);
        if (existing !== undefined) clearTimeout(existing);
        flashes[seat] = life < prior ? 'damage' : 'heal';
        timers.set(
          seat,
          setTimeout(() => {
            flashes[seat] = null;
            timers.delete(seat);
          }, 900),
        );
      }
    },
    { deep: true },
  );

  return flashes;
}
