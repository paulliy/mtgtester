<script setup lang="ts">
/**
 * A zone drawn as a pile of cards, Arena style: the top few cards stacked with a slight offset,
 * the zone's name and count under them. Clicking it opens or closes the zone. It glows when
 * something inside can be used or targeted right now, so a closed pile never hides a choice.
 */
import { computed } from 'vue';
import CardImage from './CardImage.vue';

const props = withDefaults(
  defineProps<{
    label: string;
    /** Cards in the zone, top card last (the order zones arrive in). */
    cards: readonly {
      id: string;
      scryfallId?: string | null;
      name: string;
      provisional?: true;
    }[];
    open: boolean;
    /** A second line under the label, e.g. "4 untapped". */
    detail?: string;
    /** `actionable`: a card inside is a source of a legal action; `targetable`: a legal target. */
    glow?: 'actionable' | 'targetable' | null;
    /** id of the region this pile opens, for `aria-controls`. */
    controls?: string;
  }>(),
  { glow: null },
);

const emit = defineEmits<{ toggle: [] }>();

/** The top three cards, bottom first so the last one paints on top. */
const shown = computed(() => props.cards.slice(-3));
</script>

<template>
  <button
    type="button"
    class="zone-pile"
    :class="[{ open: props.open, empty: props.cards.length === 0 }, props.glow]"
    :aria-expanded="props.open"
    :aria-controls="props.controls"
    :title="`${props.open ? 'Close' : 'Open'} ${props.label.toLowerCase()}`"
    @click.stop="emit('toggle')"
  >
    <span class="pile-cards" aria-hidden="true">
      <span
        v-for="(card, i) in shown"
        :key="card.id"
        class="pile-card"
        :style="{ '--depth': shown.length - 1 - i }"
      >
        <CardImage
          :scryfall-id="card.scryfallId ?? null"
          :name="card.name"
          size="small"
          :provisional="card.provisional === true"
        />
      </span>
      <span class="pile-count">{{ props.cards.length }}</span>
    </span>
    <span class="pile-label">{{ props.label }}</span>
    <span v-if="props.detail" class="pile-detail">{{ props.detail }}</span>
  </button>
</template>

<style scoped>
.zone-pile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  width: 84px;
  padding: 0.3rem 0.2rem 0.25rem;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.zone-pile:hover {
  background: var(--surface-2);
}
.zone-pile.open {
  border-color: var(--line);
  background: var(--surface-2);
}
/* A fixed card-shaped slot; each card below the top one peeks out up and to the left. */
.pile-cards {
  position: relative;
  width: 60px;
  aspect-ratio: 63 / 88;
  border-radius: 4px;
}
.zone-pile.empty .pile-cards {
  border: 1px dashed var(--line);
}
.pile-card {
  position: absolute;
  inset: 0;
  transform: translate(calc(var(--depth) * -3px), calc(var(--depth) * -3px));
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.45);
}
.pile-card :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pile-count {
  position: absolute;
  right: -6px;
  bottom: -6px;
  min-width: 22px;
  height: 22px;
  padding: 0 4px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: #1c1917;
  border: 2px solid var(--surface);
  color: #fff;
  font-size: 0.72rem;
  font-weight: 800;
}
.pile-label {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--muted);
}
.pile-detail {
  margin-top: -0.15rem;
  font-size: 0.66rem;
  color: var(--ok);
  white-space: nowrap;
}
/* Same affordances as an actionable or targetable card elsewhere on the board. */
.zone-pile.actionable .pile-cards {
  box-shadow:
    0 0 0 2px rgb(96 165 250 / 0.55),
    0 0 14px rgb(96 165 250 / 0.45);
}
.zone-pile.targetable .pile-cards {
  outline: 2px solid var(--accent, #7ab3f5);
  outline-offset: 2px;
}
</style>
