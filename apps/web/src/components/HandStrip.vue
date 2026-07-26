<script setup lang="ts">
/**
 * A player's hand, always visible (spectator-only — brief §10.2 calls this out separately from
 * the click-to-expand battlefield/graveyard/exile). Overlapping thumbnails keep the strip's
 * width from growing linearly with hand size; hovering one fans it back into view.
 */
import type { SpectatorCard } from '@mtg/shared';
import CardImage from './CardImage.vue';
import { useCardPreviewStore } from '../stores/cardPreview';

defineProps<{ cards: SpectatorCard[] }>();

const cardPreview = useCardPreviewStore();

function onEnter(card: SpectatorCard, event: MouseEvent): void {
  cardPreview.show({ scryfallId: card.scryfallId, name: card.name });
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onMove(event: MouseEvent): void {
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onLeave(): void {
  cardPreview.hide();
}
</script>

<template>
  <div class="hand-strip">
    <div
      v-for="card in cards"
      :key="card.id"
      class="thumb"
      @mouseenter="onEnter(card, $event)"
      @mousemove="onMove"
      @mouseleave="onLeave"
    >
      <CardImage :scryfall-id="card.scryfallId" :name="card.name" size="small" />
    </div>
    <p v-if="cards.length === 0" class="empty">empty</p>
  </div>
</template>

<style scoped>
.hand-strip {
  display: flex;
  align-items: flex-end;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.2rem 0.1rem;
}
.thumb {
  width: 56px;
  flex-shrink: 0;
  transition: margin-left 100ms ease, z-index 0s;
}
.thumb:not(:first-child) {
  margin-left: -2.2rem;
}
.thumb:hover {
  margin-left: 0;
  z-index: 1;
}
.empty {
  margin: 0;
  color: var(--muted);
  font-style: italic;
  font-size: 0.75rem;
}
</style>
