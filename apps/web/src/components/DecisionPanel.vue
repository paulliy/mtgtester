<script setup lang="ts">
/**
 * Generic renderer for a `general` decision (discard, scry, surveil, proliferate, order,
 * and any future card-specific choice) driven entirely by `DecisionRequest.presentation`
 * (brief — player-experience overhaul, Workstream 3). No `type` allowlist, no description
 * regex: a card override that yields through `present.ts`'s helpers is usable here for free.
 *
 * An option with no presentation entry still renders — as its raw `description` in a plain
 * button — rather than being hidden. A missing label is a UI gap, not a reason to bury the
 * option in a details element the player has to find.
 */
import { computed } from 'vue';
import type { ActionSubject, DecisionRequest, LegalAction } from '@mtg/shared';
import CardImage from './CardImage.vue';
import { useCardPreviewStore } from '../stores/cardPreview';

const props = defineProps<{ request: DecisionRequest }>();
const emit = defineEmits<{ (event: 'choose', actionId: number): void }>();
const cardPreview = useCardPreviewStore();

interface Group {
  key: string;
  subject: ActionSubject | null;
  actions: LegalAction[];
}

function subjectFor(action: LegalAction): ActionSubject | null {
  return props.request.presentation?.actions?.[action.id]?.subjects[0] ?? null;
}
function verbFor(action: LegalAction): string {
  return props.request.presentation?.actions?.[action.id]?.verb ?? action.description;
}
function roleFor(action: LegalAction): string | undefined {
  return props.request.presentation?.actions?.[action.id]?.role;
}
function subjectKey(subject: ActionSubject | null, index: number): string {
  if (subject === null) return `none-${index}`;
  if (subject.kind === 'card') return `card-${subject.card.objectId}`;
  if (subject.kind === 'player') return `player-${subject.playerId}`;
  return `value-${index}`;
}

const groups = computed<Group[]>(() => {
  const byKey = new Map<string, Group>();
  props.request.legalActions.forEach((action, index) => {
    const subject = subjectFor(action);
    const key = subjectKey(subject, index);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.actions.push(action);
      return;
    }
    byKey.set(key, { key, subject, actions: [action] });
  });
  return [...byKey.values()];
});

const sourceLabel = computed(() => props.request.presentation?.source?.name ?? null);
const sourceScryfallId = computed(() => props.request.presentation?.source?.scryfallId ?? null);

function showPreview(name: string, scryfallId: string | null, event: MouseEvent): void {
  cardPreview.show({ scryfallId, name });
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function movePreview(event: MouseEvent): void {
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function hidePreview(): void {
  cardPreview.hide();
}
</script>

<template>
  <section class="decision-panel" aria-live="polite">
    <div v-if="sourceLabel" class="panel-source">
      <CardImage :scryfall-id="sourceScryfallId" :name="sourceLabel" size="small" />
      <strong>{{ sourceLabel }}</strong>
    </div>
    <p class="panel-prompt">{{ request.prompt }}</p>
    <div class="panel-groups">
      <div v-for="group in groups" :key="group.key" class="panel-group">
        <div
          v-if="group.subject?.kind === 'card'"
          class="group-card"
          @mouseenter="showPreview(group.subject.card.name, group.subject.card.scryfallId, $event)"
          @mousemove="movePreview"
          @mouseleave="hidePreview"
        >
          <CardImage :scryfall-id="group.subject.card.scryfallId" :name="group.subject.card.name" size="small" />
          <span>{{ group.subject.card.name }}</span>
        </div>
        <div v-else-if="group.subject?.kind === 'player'" class="group-player">
          <span>{{ group.subject.label }}</span>
        </div>
        <div v-else-if="group.subject?.kind === 'value'" class="group-value">
          <span>{{ group.subject.label }}</span>
        </div>
        <div class="group-actions">
          <button
            v-for="action in group.actions"
            :key="action.id"
            type="button"
            :class="{ primary: roleFor(action) === 'affirm', muted: roleFor(action) === 'decline' }"
            @click="emit('choose', action.id)"
          >
            {{ verbFor(action) }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.decision-panel { border: 2px solid var(--accent); background: var(--surface); border-radius: 6px; padding: .55rem; }
.panel-source { display: flex; align-items: center; gap: .4rem; margin-bottom: .3rem; }
.panel-source :deep(.card-image) { width: 28px; }
.panel-prompt { margin: .15rem 0 .5rem; color: var(--muted); font-size: .75rem; line-height: 1.35; }
.panel-groups { display: flex; flex-direction: column; gap: .5rem; }
.panel-group { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.group-card { display: flex; align-items: center; gap: .3rem; width: 90px; flex: 0 0 auto; font-size: .65rem; text-align: left; }
.group-card :deep(.card-image) { width: 60px; }
.group-card span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-player, .group-value { font-size: .72rem; color: var(--muted); min-width: 3.5rem; }
.group-actions { display: flex; flex-wrap: wrap; gap: .3rem; }
button.primary { background: var(--accent); color: #08111f; font-weight: 700; }
button.muted { color: var(--muted); }
</style>
