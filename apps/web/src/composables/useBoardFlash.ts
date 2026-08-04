/**
 * Generalizes the original life-flash idea (watch a piece of reactive state, derive a transient
 * class from the delta, clear it on a timeout) so damage marks, tapping, and other board-change
 * feedback can reuse the same shape instead of each growing its own bespoke composable.
 */
import { reactive, ref, watch } from 'vue';

export function useBoardFlash<T>(
  key: () => T,
  classify: (prev: T, next: T) => string | null,
  ms = 900,
) {
  const flash = ref<string | null>(null);
  let previous = key();
  let timer: ReturnType<typeof setTimeout> | null = null;

  watch(key, (next) => {
    const prev = previous;
    previous = next;
    const cls = classify(prev, next);
    if (cls === null) return;
    if (timer !== null) clearTimeout(timer);
    flash.value = cls;
    timer = setTimeout(() => {
      flash.value = null;
      timer = null;
    }, ms);
  });

  return flash;
}

/** Same idea, keyed by id — for a `v-for` of permanents/seats reacting independently. */
export function useBoardFlashByKey<T>(
  items: () => Array<{ key: string; value: T }>,
  classify: (prev: T, next: T) => string | null,
  ms = 900,
) {
  const flashes = reactive<Record<string, string | null>>({});
  const previous = new Map<string, T>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  watch(
    items,
    (current) => {
      for (const { key, value } of current) {
        const prior = previous.get(key);
        previous.set(key, value);
        if (prior === undefined) continue;
        const cls = classify(prior, value);
        if (cls === null) continue;
        const existing = timers.get(key);
        if (existing !== undefined) clearTimeout(existing);
        flashes[key] = cls;
        timers.set(
          key,
          setTimeout(() => {
            flashes[key] = null;
            timers.delete(key);
          }, ms),
        );
      }
    },
    { deep: true },
  );

  return flashes;
}
