import type { ComponentPublicInstance } from 'vue';
import { onBeforeUnmount, reactive } from 'vue';

/**
 * Live content-box sizes of named zones, for sizing card tiles to fill them (`fitTileWidth`).
 * `zoneRef(key)` is a template ref callback; it accepts an element or a component (a
 * TransitionGroup's root element is used).
 */
export function useZoneSizes() {
  const sizes = reactive(new Map<string, { width: number; height: number }>());
  const elements = new Map<string, Element>();
  const callbacks = new Map<string, (el: Element | ComponentPublicInstance | null) => void>();
  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          for (const entry of entries) {
            const key = (entry.target as HTMLElement).dataset['zoneKey'];
            if (key === undefined) continue;
            const { width, height } = entry.contentRect;
            const prev = sizes.get(key);
            if (prev && Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) {
              continue;
            }
            sizes.set(key, { width, height });
          }
        });

  function zoneRef(key: string): (el: Element | ComponentPublicInstance | null) => void {
    const existing = callbacks.get(key);
    if (existing) return existing;
    const callback = (target: Element | ComponentPublicInstance | null): void => {
      const el =
        target === null ? null : target instanceof Element ? target : (target.$el as Element);
      const prev = elements.get(key);
      if (prev === el) return;
      if (prev) observer?.unobserve(prev);
      if (el instanceof HTMLElement) {
        el.dataset['zoneKey'] = key;
        elements.set(key, el);
        observer?.observe(el);
      } else {
        elements.delete(key);
        sizes.delete(key);
      }
    };
    callbacks.set(key, callback);
    return callback;
  }

  onBeforeUnmount(() => observer?.disconnect());

  return { sizes, zoneRef };
}
