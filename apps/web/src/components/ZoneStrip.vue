<script setup lang="ts">
/** A titled row of card thumbnails with hover preview — graveyard, exile, and similar zones. */
import { computed } from 'vue';
import type { SpectatorCard } from '@mtg/shared';
import CardImage from './CardImage.vue';
import { isTokenTypeLine } from '../lib/card';
import { useCardPreviewStore } from '../stores/cardPreview';

const props = withDefaults(
  defineProps<{
    label: string;
    cards: SpectatorCard[];
    /** Cap the visible thumbnails, showing a "+N" overflow chip for the rest. Uncapped by default. */
    max?: number;
  }>(),
  { max: Infinity },
);

const visibleCards = computed(() => props.cards.slice(0, props.max));
const overflowCount = computed(() => Math.max(0, props.cards.length - props.max));

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
        v-for="card in visibleCards"
        :key="card.id"
        class="zone-card-thumb"
        @mouseenter="onCardEnter(card, $event)"
        @mousemove="onCardMove"
        @mouseleave="onCardLeave"
      >
        <CardImage
          :scryfall-id="card.scryfallId"
          :name="card.name"
          :is-token="isTokenTypeLine(card.typeLine)"
          size="small"
        />
      </div>
      <div v-if="overflowCount > 0" class="zone-overflow">+{{ overflowCount }}</div>
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
  flex-shrink: 0;
}
.zone-overflow {
  flex-shrink: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  border: 1px dashed var(--line);
  border-radius: 4px;
  color: var(--muted);
  font-size: 0.68rem;
  font-weight: 700;
}
</style>
