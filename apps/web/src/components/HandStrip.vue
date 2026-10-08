<script setup lang="ts">
/**
 * A player's hand, always visible (spectator-only — brief §10.2 calls this out separately from
 * the click-to-expand battlefield/graveyard/exile). Overlapping thumbnails keep the strip's
 * width from growing linearly with hand size; hovering one fans it back into view.
 */
import type { SpectatorCard } from '@mtg/shared';
import CardImage from './CardImage.vue';
import { isTokenTypeLine } from '../lib/card';
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
  <TransitionGroup tag="div" name="hand-thumb" class="hand-strip">
    <div
      v-for="card in cards"
      :key="card.id"
      class="thumb"
      @mouseenter="onEnter(card, $event)"
      @mousemove="onMove"
      @mouseleave="onLeave"
    >
      <CardImage
        :scryfall-id="card.scryfallId"
        :name="card.name"
        :is-token="isTokenTypeLine(card.typeLine)"
        size="small"
      />
    </div>
    <p v-if="cards.length === 0" key="empty" class="empty">empty</p>
  </TransitionGroup>
</template>

<style scoped>
.hand-strip {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 0.25rem;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.2rem 0.1rem;
}
.hand-thumb-enter-active,
.hand-thumb-leave-active {
  transition:
    opacity 240ms ease,
    transform 240ms ease;
}
.hand-thumb-move {
  transition: transform 240ms ease;
}
.hand-thumb-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.92);
}
.hand-thumb-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.94);
}
.hand-thumb-leave-active {
  position: absolute;
}
.thumb {
  width: 40px;
  flex-shrink: 0;
}
.empty {
  margin: 0;
  color: var(--muted);
  font-style: italic;
  font-size: 0.75rem;
}
</style>
