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
    /**
     * `row` draws the zone as a ruled line of text, its name left and its count right, the way
     * the board design's rail lists your graveyard and exile.
     */
    variant?: 'pile' | 'row';
  }>(),
  { glow: null, variant: 'pile' },
);

const emit = defineEmits<{ toggle: [] }>();

/** The top three cards, bottom first so the last one paints on top. */
const shown = computed(() => props.cards.slice(-3));
</script>

<template>
  <button
    type="button"
    class="zone-pile"
    :class="[
      { open: props.open, empty: props.cards.length === 0, row: props.variant === 'row' },
      props.glow,
    ]"
    :aria-expanded="props.open"
    :aria-controls="props.controls"
    :title="`${props.open ? 'Close' : 'Open'} ${props.label.toLowerCase()}`"
    @click.stop="emit('toggle')"
  >
    <template v-if="props.variant === 'row'">
      <span class="pile-label">{{ props.label }}</span>
      <span v-if="props.detail" class="pile-detail">{{ props.detail }}</span>
      <span class="pile-num">{{ props.cards.length }}</span>
    </template>
    <span v-else class="pile-cards" aria-hidden="true">
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
    <template v-if="props.variant !== 'row'">
      <span class="pile-label">{{ props.label }}</span>
      <span v-if="props.detail" class="pile-detail">{{ props.detail }}</span>
    </template>
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
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
}
.zone-pile:hover {
  background: var(--paper);
}
.zone-pile.open {
  border-color: var(--ink);
  background: var(--paper);
}
/* A fixed card-shaped slot; each card below the top one peeks out up and to the left. */
.pile-cards {
  position: relative;
  width: 60px;
  aspect-ratio: 5 / 7;
}
.zone-pile.empty .pile-cards {
  border: 1px solid var(--rule);
}
.pile-card {
  position: absolute;
  inset: 0;
  transform: translate(calc(var(--depth) * -3px), calc(var(--depth) * -3px));
  overflow: hidden;
  border: 1px solid var(--ink);
  background: var(--paper);
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
  background: var(--ink);
  color: var(--paper);
  font-family: var(--font-ui);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
}
.pile-label {
  font-family: var(--font-ui);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink);
}
.pile-detail {
  margin-top: -0.15rem;
  font-family: var(--font-body);
  font-size: 0.64rem;
  color: var(--muted);
  white-space: nowrap;
}
/* Same affordances as an actionable or targetable card elsewhere on the board. */
.zone-pile.actionable .pile-cards {
  box-shadow: 0 0 0 2px var(--warm);
}
.zone-pile.targetable .pile-cards {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
/* Row: a ruled line in the rail, "Graveyard ........ 4", in the body face. */
.zone-pile.row {
  width: 100%;
  min-height: 40px;
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  padding: 0;
  border: 0;
  text-align: left;
  font-family: var(--font-body);
  font-size: 0.9rem;
}
.zone-pile.row:hover,
.zone-pile.row.open {
  border: 0;
  background: transparent;
}
.zone-pile.row .pile-label {
  font-family: inherit;
  font-size: inherit;
  letter-spacing: 0;
  text-transform: none;
}
.zone-pile.row.open .pile-label {
  text-decoration: underline;
  text-underline-offset: 0.25em;
}
.zone-pile.row .pile-detail {
  margin: 0;
  font-size: 0.72rem;
}
.pile-num {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.zone-pile.row.actionable {
  box-shadow: inset 3px 0 0 var(--warm);
  padding-left: 0.5rem;
}
.zone-pile.row.targetable {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
  padding-left: 0.5rem;
}
</style>
