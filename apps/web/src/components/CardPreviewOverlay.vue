<script setup lang="ts">
/**
 * Singleton floating preview, mounted once in App.vue. `pointer-events: none` so it never
 * itself becomes a hover target or blocks a click on whatever it's floating over.
 *
 * Battlefield tiles show only art (or, for tokens, only P/T), so this is where a permanent's full
 * card lives: the printed card image plus its live state, or a text frame for a token, which has
 * no printing to show.
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
/** Approximate height of one line in the live-state panel under the image, for edge clamping. */
const DETAIL_LINE_PX = 20;

const card = computed(() => store.hovered);

/**
 * A card with no printing — a token made from the catalog, a face-down permanent — gets a text
 * frame instead of an image. A token copy of a real card has that card's printing, so it shows it.
 */
const textMode = computed(() => card.value !== null && card.value.scryfallId === null);

const ptText = computed(() => {
  const c = card.value;
  if (c === null || c.power === undefined || c.power === null) return null;
  return `${c.power}/${c.toughness ?? 0}`;
});

/** Live-state lines under an image. A text frame shows these inside the frame instead. */
const details = computed(() => {
  const c = card.value;
  if (c === null) return [];
  const lines: string[] = [];
  if (ptText.value !== null) {
    const damage = (c.damageMarked ?? 0) > 0 ? ` · ${c.damageMarked} damage` : '';
    lines.push(`Now ${ptText.value}${damage}`);
  }
  if (c.keywords !== undefined && c.keywords.length > 0) lines.push(c.keywords.join(', '));
  if (c.counters !== undefined && c.counters !== '') lines.push(`Counters: ${c.counters}`);
  return lines;
});

/**
 * Anchored to whichever side of the cursor has room, not always bottom-right — otherwise the
 * preview for a card near the right/bottom of a quadrant lands right back on top of the panel
 * you're inspecting (that's what a fixed bottom-right offset did before this fix).
 */
const style = computed(() => {
  const size = SIZE_PX[store.previewSize];
  const extra =
    textMode.value || details.value.length === 0 ? 0 : 16 + details.value.length * DETAIL_LINE_PX;
  const box = { width: size.width, height: size.height + extra };
  const onRightHalf = store.cursorX > window.innerWidth / 2;
  const onBottomHalf = store.cursorY > window.innerHeight / 2;

  const left = onRightHalf ? store.cursorX - OFFSET - box.width : store.cursorX + OFFSET;
  const top = onBottomHalf ? store.cursorY - OFFSET - box.height : store.cursorY + OFFSET;

  const clampedLeft = Math.min(Math.max(8, left), window.innerWidth - box.width - 8);
  // A text frame is sized to its content, so its height is unknown here: below the middle of the
  // screen, pin its bottom edge above the cursor rather than guessing where its top goes.
  if (textMode.value && onBottomHalf) {
    const bottom = Math.max(8, window.innerHeight - store.cursorY + OFFSET);
    return { left: `${clampedLeft}px`, bottom: `${bottom}px` };
  }
  const clampedTop = Math.min(Math.max(8, top), window.innerHeight - box.height - 8);
  return { left: `${clampedLeft}px`, top: `${clampedTop}px` };
});
</script>

<template>
  <div v-if="card" class="preview" :class="store.previewSize" :style="style">
    <div v-if="textMode" class="text-card">
      <div class="text-head">
        <span class="text-name">{{ card.name }}</span>
        <span v-if="card.manaCost" class="text-cost">{{ card.manaCost }}</span>
      </div>
      <div v-if="card.typeLine" class="text-type">{{ card.typeLine }}</div>
      <div
        v-if="
          card.oracleText ||
          (card.keywords && card.keywords.length > 0) ||
          card.counters ||
          (card.damageMarked ?? 0) > 0
        "
        class="text-body"
      >
        <p v-if="card.oracleText" class="text-oracle">{{ card.oracleText }}</p>
        <p v-if="card.keywords && card.keywords.length > 0" class="text-live">
          {{ card.keywords.join(', ') }}
        </p>
        <p v-if="card.counters" class="text-live">Counters: {{ card.counters }}</p>
        <p v-if="(card.damageMarked ?? 0) > 0" class="text-live">
          {{ card.damageMarked }} damage marked
        </p>
      </div>
      <div v-if="ptText" class="text-pt">{{ ptText }}</div>
    </div>
    <template v-else>
      <CardImage
        :scryfall-id="card.scryfallId"
        :name="card.name"
        :face="card.imageFace ?? 'front'"
        :size="store.previewSize"
      />
      <div v-if="details.length > 0" class="details">
        <div v-for="line in details" :key="line">{{ line }}</div>
      </div>
    </template>
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
.details {
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgb(11 13 17 / 0.92);
  border: 1px solid var(--line);
  color: #f0f4f8;
  font-size: 0.8rem;
  line-height: 1.5;
}
/* Sized to its content: a vanilla token is a few lines, not a card-sized blank frame. */
.text-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  border-radius: 4.5% / 3.5%;
  border: 6px solid #1a1d23;
  background: var(--surface);
  color: var(--text);
  overflow: hidden;
}
.preview.large .text-card {
  font-size: 1.15rem;
}
.text-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.45rem 0.6rem;
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
}
.text-name {
  font-weight: 700;
  font-size: 0.95em;
}
.text-cost {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8em;
  color: var(--muted);
}
.text-type {
  padding: 0.35rem 0.6rem;
  font-size: 0.8em;
  font-weight: 600;
  border-bottom: 1px solid var(--line);
}
.text-body {
  padding: 0.5rem 0.6rem;
  font-size: 0.82em;
  line-height: 1.45;
  overflow: hidden;
}
.text-body p {
  margin: 0 0 0.4rem;
}
.text-oracle {
  white-space: pre-line;
}
.text-live {
  color: var(--accent);
}
.text-pt {
  align-self: flex-end;
  margin: 0.5rem;
  padding: 0.15rem 0.6rem;
  border-radius: 6px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
</style>
