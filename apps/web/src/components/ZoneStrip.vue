<script setup lang="ts">
/** A titled row of card thumbnails with hover preview — graveyard, exile, and similar zones. */
import type { SpectatorCard } from '@mtg/shared';
import CardImage from './CardImage.vue';
import { useCardPreviewStore } from '../stores/cardPreview';

const props = defineProps<{
  label: string;
  cards: SpectatorCard[];
}>();

const cardPreview = useCardPreviewStore();

function onCardEnter(card: SpectatorCard, event: MouseEvent): void {
  cardPreview.show({ scryfallId: card.scryfallId, name: card.name });
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onCardMove(event: MouseEvent): void {
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onCardLeave(): void {
  cardPreview.hide();
}
</script>

<template>
  <div v-if="props.cards.length > 0" class="zone">
    <h4>{{ props.label }} ({{ props.cards.length }})</h4>
    <div class="cards-strip">
      <div
        v-for="card in props.cards"
        :key="card.id"
        class="zone-card-thumb"
        @mouseenter="onCardEnter(card, $event)"
        @mousemove="onCardMove"
        @mouseleave="onCardLeave"
      >
        <CardImage :scryfall-id="card.scryfallId" :name="card.name" size="small" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.zone {
  border-top: 1px solid var(--line);
  padding-top: 0.4rem;
}
.zone h4 {
  margin: 0 0 0.2rem;
  font-size: 0.68rem;
  color: var(--muted);
  font-weight: 600;
}
.cards-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  max-height: 9rem;
  overflow-y: auto;
  padding: 0.2rem 0;
}
.zone-card-thumb {
  width: 52px;
}
</style>
