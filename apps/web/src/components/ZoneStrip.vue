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
    /**
     * Object ids that are legal targets of the action currently being composed (for example a
     * "return target card from your graveyard" ability). Those cards become clickable; every
     * other card stays display-only.
     */
    selectableIds?: string[];
    /**
     * Object ids of cards in this zone that are themselves sources of a legal action right now —
     * an unearth or flashback in a graveyard. Clicking one opens its actions, as a hand card or
     * permanent does. A pending target choice takes precedence.
     */
    actionableIds?: string[];
  }>(),
  { max: Infinity, selectableIds: () => [], actionableIds: () => [] },
);

const emit = defineEmits<{ select: [id: string]; activate: [id: string] }>();

function isClickable(card: SpectatorCard): boolean {
  return props.selectableIds.includes(card.id) || props.actionableIds.includes(card.id);
}

function onCardClick(card: SpectatorCard): void {
  if (props.selectableIds.includes(card.id)) emit('select', card.id);
  else if (props.actionableIds.includes(card.id)) emit('activate', card.id);
}

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
  <div class="zone" :class="{ empty: props.cards.length === 0 }">
    <h4 v-if="props.cards.length > 0">{{ props.label }} ({{ props.cards.length }})</h4>
    <TransitionGroup tag="div" name="zone-card" class="cards-strip">
      <div
        v-for="card in visibleCards"
        :key="card.id"
        class="zone-card-thumb"
        :class="{
          targetable: props.selectableIds.includes(card.id),
          actionable:
            !props.selectableIds.includes(card.id) && props.actionableIds.includes(card.id),
        }"
        :role="isClickable(card) ? 'button' : undefined"
        :tabindex="isClickable(card) ? 0 : undefined"
        @click="onCardClick(card)"
        @keydown.enter.prevent="onCardClick(card)"
        @keydown.space.prevent="onCardClick(card)"
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
      <div v-if="overflowCount > 0" key="overflow" class="zone-overflow">+{{ overflowCount }}</div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.zone {
  border-top: 1px solid var(--line);
  padding-top: 0.4rem;
}
.zone.empty {
  height: 0;
  overflow: visible;
  border: 0;
  padding: 0;
}
.zone h4 {
  margin: 0 0 0.2rem;
  font-size: 0.68rem;
  color: var(--muted);
  font-weight: 600;
}
.cards-strip {
  position: relative;
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
.zone-card-enter-active,
.zone-card-leave-active {
  transition:
    opacity 260ms ease,
    transform 260ms cubic-bezier(0.2, 0.7, 0.25, 1);
}
.zone-card-move {
  transition: transform 260ms ease;
}
.zone-card-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.9);
}
.zone-card-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.94);
}
.zone-card-leave-active {
  position: absolute;
}
.zone-card-thumb.targetable {
  cursor: pointer;
  outline: 2px solid var(--accent, #7ab3f5);
  outline-offset: 1px;
  border-radius: 4px;
}
/* Same affordance as an actionable hand card or permanent on the board. */
.zone-card-thumb.actionable {
  cursor: pointer;
  border-radius: 4px;
  box-shadow:
    0 0 0 2px rgb(96 165 250 / 0.45),
    0 0 14px rgb(96 165 250 / 0.35);
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
