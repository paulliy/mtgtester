<script setup lang="ts">
/**
 * The stack, top first (brief §10.2 — "the stack with current targets"). LIFO: the last object
 * pushed is the first to resolve, so it is shown at the top of the list.
 */
import { computed } from 'vue';
import type { PlayerBoardState, SpectatorState } from '@mtg/shared';
import CardImage from './CardImage.vue';
import { useCardPreviewStore } from '../stores/cardPreview';

const props = defineProps<{
  state: SpectatorState | PlayerBoardState;
  /** Spectator views omit these — stack objects are then inert, display-only. */
  isLegalTarget?: (id: string) => boolean;
  isChosenTarget?: (id: string) => boolean;
}>();
const emit = defineEmits<{ select: [id: string] }>();

const cardPreview = useCardPreviewStore();

const topFirst = computed(() => [...props.state.stack].reverse());

function onEnter(scryfallId: string | null, name: string, event: MouseEvent): void {
  cardPreview.show({ scryfallId, name });
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onMove(event: MouseEvent): void {
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onLeave(): void {
  cardPreview.hide();
}

/** Object ids mean nothing to a reader; resolve them to names where the board still has them. */
const nameOf = computed(() => {
  const map = new Map<string, string>();
  for (const perm of props.state.battlefield) map.set(perm.id, perm.name);
  for (const obj of props.state.stack) map.set(obj.id, obj.description);
  for (const seat of props.state.seats) map.set(seat.seat, seat.seat);
  return map;
});
</script>

<template>
  <div class="stack">
    <h3>Stack</h3>
    <ol v-if="topFirst.length > 0">
      <li
        v-for="(obj, index) in topFirst"
        :key="obj.id"
        :class="{ targetable: isLegalTarget?.(obj.id), 'chosen-target': isChosenTarget?.(obj.id) }"
        @mouseenter="onEnter(obj.scryfallId, obj.description, $event)"
        @mousemove="onMove"
        @mouseleave="onLeave"
        @click="emit('select', obj.id)"
      >
        <CardImage :scryfall-id="obj.scryfallId" :name="obj.description" size="small" class="thumb" />
        <span class="pos">{{ index === 0 ? 'top' : index + 1 }}</span>
        <span class="who">{{ obj.controller }}</span>
        <span class="desc">{{ obj.description }}</span>
        <span v-if="obj.targets.length > 0" class="targets">
          → {{ obj.targets.map((t) => nameOf.get(t) ?? t).join(', ') }}
        </span>
      </li>
    </ol>
    <p v-else class="empty">empty</p>
  </div>
</template>

<style scoped>
.stack {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  padding: 0.4rem 0.5rem;
}
h3 {
  margin: 0 0 0.3rem;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.72rem;
}
li {
  display: flex;
  gap: 0.35rem;
  align-items: center;
  border-radius: 3px;
}
li.targetable {
  cursor: pointer;
  outline: 1px solid var(--ok);
  box-shadow: 0 0 0 1px var(--ok);
}
li.chosen-target {
  outline: 2px solid var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}
.thumb {
  width: 22px;
  flex-shrink: 0;
}
.pos,
.who {
  color: var(--muted);
  font-size: 0.65rem;
  white-space: nowrap;
}
.desc {
  flex: 1;
}
.targets {
  color: var(--accent);
  font-size: 0.66rem;
}
.empty {
  margin: 0;
  color: var(--muted);
  font-style: italic;
  font-size: 0.72rem;
}
</style>
