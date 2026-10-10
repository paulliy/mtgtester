/**
 * The hover/Alt-zoom card preview: hovering any card shows a floating close-up near the
 * cursor, holding Alt swaps it to an even larger size. A single store rather than a per-card
 * tooltip — a 4-player board can have 100+ cards visible at once, and one shared overlay avoids
 * that many tooltip DOM nodes and z-index fights.
 */

import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';

export interface PreviewCard {
  scryfallId: string | null;
  name: string;
  imageFace?: 'front' | 'back';
}

export const useCardPreviewStore = defineStore('cardPreview', () => {
  const hovered = shallowRef<PreviewCard | null>(null);
  const altHeld = ref(false);
  const cursorX = ref(0);
  const cursorY = ref(0);

  const previewSize = computed(() => (altHeld.value ? 'large' : 'normal'));

  function show(card: PreviewCard): void {
    hovered.value = card;
  }

  function hide(): void {
    hovered.value = null;
  }

  function updateCursor(x: number, y: number): void {
    cursorX.value = x;
    cursorY.value = y;
  }

  function setAltHeld(value: boolean): void {
    altHeld.value = value;
  }

  return { hovered, altHeld, cursorX, cursorY, previewSize, show, hide, updateCursor, setAltHeld };
});
