<script setup lang="ts">
import { computed } from 'vue';
import type { DecisionRequest, LegalAction } from '@mtg/shared';
import CardImage from './CardImage.vue';
import { useCardPreviewStore } from '../stores/cardPreview';

const props = defineProps<{ request: DecisionRequest }>();
const emit = defineEmits<{ (event: 'choose', actionId: number): void }>();
const cardPreview = useCardPreviewStore();

const EFFECT_ACTIONS = new Set([
  'discard',
  'scryKeep',
  'scryBottom',
  'surveilKeep',
  'surveilGraveyard',
  'keepOrder',
  'reorder',
  'orderLibrary',
  'proliferate',
  'skipProliferate',
]);

const supported = computed(
  () =>
    props.request.decisionType === 'general' &&
    props.request.legalActions.length > 0 &&
    props.request.legalActions.every((action) => EFFECT_ACTIONS.has(action.type)),
);
const kind = computed(() => props.request.legalActions[0]?.type ?? '');
const title = computed(() => {
  if (kind.value === 'discard') return 'Choose a card to discard';
  if (kind.value.startsWith('scry')) return 'Scry';
  if (kind.value.startsWith('surveil')) return 'Surveil';
  if (kind.value === 'orderLibrary') return 'Choose the next card';
  if (kind.value === 'proliferate' || kind.value === 'skipProliferate') return 'Proliferate';
  return 'Arrange cards';
});
const choiceCards = computed(() =>
  props.request.legalActions.map((action) => ({ action, name: cardName(action) })),
);

function cardName(action: LegalAction): string | null {
  const match = action.description.match(/(?:Discard|Keep|Put) (.+?)(?: (?:on top|on the bottom|into your graveyard|next on the (?:top|bottom)))?$/i);
  return match?.[1] ?? null;
}
function onEnter(name: string, event: MouseEvent): void {
  cardPreview.show({ scryfallId: null, name });
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
  <section v-if="supported" class="effect-decision" aria-live="polite">
    <h3>{{ title }}</h3>
    <p>{{ request.prompt }}</p>

    <div v-if="kind === 'discard' || kind === 'orderLibrary'" class="card-choices">
      <button
        v-for="choice in choiceCards"
        :key="choice.action.id"
        type="button"
        class="card-choice"
        @click="emit('choose', choice.action.id)"
        @mouseenter="choice.name !== null && onEnter(choice.name, $event)"
        @mousemove="onMove"
        @mouseleave="onLeave"
      >
        <CardImage :scryfall-id="null" :name="choice.name ?? choice.action.description" size="small" />
        <span>{{ choice.name ?? choice.action.description }}</span>
      </button>
    </div>

    <div v-else class="effect-actions">
      <button
        v-for="action in request.legalActions"
        :key="action.id"
        type="button"
        :class="{ primary: action.type === 'scryKeep' || action.type === 'surveilKeep' || action.type === 'keepOrder' }"
        @click="emit('choose', action.id)"
      >
        {{ action.description }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.effect-decision { border: 2px solid var(--accent); background: var(--surface); border-radius: 6px; padding: .55rem; }
h3, p { margin: .15rem 0 .45rem; }
p { color: var(--muted); font-size: .75rem; line-height: 1.35; }
.effect-actions, .card-choices { display: flex; flex-wrap: wrap; gap: .4rem; }
.effect-actions button { text-align: left; }
.primary { background: var(--accent); color: #08111f; font-weight: 700; }
.card-choice { width: 92px; padding: .2rem; display: flex; flex-direction: column; gap: .2rem; text-align: left; font-size: .65rem; overflow: hidden; }
.card-choice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
