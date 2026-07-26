<script setup lang="ts">
/**
 * Singleton floating preview, mounted once in App.vue. `pointer-events: none` so it never
 * itself becomes a hover target or blocks a click on whatever it's floating over.
 */
import { computed } from 'vue';
import CardImage from './CardImage.vue';
import { useCardPreviewStore } from '../stores/cardPreview';

const store = useCardPreviewStore();

/** Matches the fixed pixel widths in the `<style>` block below — kept in sync by hand. */
const SIZE_PX: Record<'normal' | 'large', { width: number; height: number }> = {
  normal: { width: 240, height: 336 },
  large: { width: 340, height: 476 },
};

const OFFSET = 24;

/**
 * Anchored to whichever side of the cursor has room, not always bottom-right — otherwise the
 * preview for a card near the right/bottom of a quadrant lands right back on top of the panel
 * you're inspecting (that's what a fixed bottom-right offset did before this fix).
 */
const style = computed(() => {
  const box = SIZE_PX[store.previewSize];
  const onRightHalf = store.cursorX > window.innerWidth / 2;
  const onBottomHalf = store.cursorY > window.innerHeight / 2;

  const left = onRightHalf ? store.cursorX - OFFSET - box.width : store.cursorX + OFFSET;
  const top = onBottomHalf ? store.cursorY - OFFSET - box.height : store.cursorY + OFFSET;

  const clampedLeft = Math.min(Math.max(8, left), window.innerWidth - box.width - 8);
  const clampedTop = Math.min(Math.max(8, top), window.innerHeight - box.height - 8);
  return { left: `${clampedLeft}px`, top: `${clampedTop}px` };
});
</script>

<template>
  <div v-if="store.hovered" class="preview" :class="store.previewSize" :style="style">
    <CardImage
      :scryfall-id="store.hovered.scryfallId"
      :name="store.hovered.name"
      :size="store.previewSize"
    />
  </div>
</template>

<style scoped>
.preview {
  position: fixed;
  pointer-events: none;
  z-index: 1000;
  filter: drop-shadow(0 4px 16px rgb(0 0 0 / 0.5));
}
.preview.normal {
  width: 240px;
}
.preview.large {
  width: 340px;
}
</style>
