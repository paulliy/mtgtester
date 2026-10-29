<script setup lang="ts">
/**
 * The spectator action log (brief §10.2): chronological, minimal format. Lines arrive
 * pre-formatted from the engine so the UI never interprets an event.
 *
 * AI reasoning is off by default and opt-in via the header toggle (ADR 0022, superseding brief
 * §15's debug-log-only rule). It renders *beside* each line, never inside `SpectatorLogLine` —
 * the engine emits the log and knows nothing about the AI.
 *
 * Table talk (ADR 0035) renders the same way: deals, answers, breaches and threat calls under the
 * play they came with. It is public, so its toggle is a view preference, on by default.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { AiAnnotation, SpectatorLogLine, TableTalkLine } from '@mtg/shared';

const props = defineProps<{
  lines: SpectatorLogLine[];
  follow: boolean;
  activeSequence?: number | undefined;
  /** Reasoning keyed by the line sequence it explains; empty when the toggle is off. */
  annotations?: Map<number, AiAnnotation[]>;
  /** Hidden entirely when reasoning cannot exist — a random-provider game has none. */
  canShowReasoning?: boolean;
  showReasoning?: boolean;
  /** Table talk keyed by the line sequence it sits under (ADR 0035). */
  talk?: Map<number, TableTalkLine[]>;
  /** Hidden entirely in a game without diplomacy. */
  canShowTalk?: boolean;
  showTalk?: boolean;
  /** The game is over, so talk past the last line is what the table said as it ended. */
  ended?: boolean;
}>();

const emit = defineEmits<{
  (event: 'selectSequence', sequence: number, turn: number): void;
  (event: 'update:showReasoning', value: boolean): void;
  (event: 'update:showTalk', value: boolean): void;
}>();

function talkFor(sequence: number): TableTalkLine[] {
  if (props.showTalk !== true) return [];
  return props.talk?.get(sequence) ?? [];
}

/**
 * Talk after the last line shown: what the table said as the game ended. Only once it has ended;
 * before then, talk past the last line belongs to plays not presented yet and must wait for them.
 */
const trailingTalk = computed(() => {
  if (props.showTalk !== true || props.ended !== true || props.talk === undefined) return [];
  const last = props.lines.at(-1)?.sequence ?? -1;
  return [...props.talk.entries()]
    .filter(([sequence]) => sequence > last)
    .sort(([a], [b]) => a - b)
    .flatMap(([, lines]) => lines);
});

function notesFor(sequence: number): AiAnnotation[] {
  if (props.showReasoning !== true) return [];
  return props.annotations?.get(sequence) ?? [];
}

const hasAnyReasoning = computed(() => (props.annotations?.size ?? 0) > 0);

const scroller = ref<HTMLElement | null>(null);

watch(
  () => props.lines.length,
  async () => {
    if (!props.follow) return;
    await nextTick();
    const el = scroller.value;
    if (el !== null) el.scrollTop = el.scrollHeight;
  },
);

watch(
  () => props.activeSequence,
  async (seq) => {
    if (seq === undefined || seq === null) return;
    await nextTick();
    const el = scroller.value?.querySelector('.line.active') as HTMLElement | null;
    // `nearest` on a list this dense leaves the active line pinned to an edge, one step from
    // scrolling out of view again; centring it keeps the surrounding context readable while
    // stepping action by action.
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
);
</script>

<template>
  <div class="log">
    <div class="log-header">
      <h3>Action log</h3>
      <label v-if="canShowReasoning" class="reasoning-toggle">
        <input
          :checked="showReasoning === true"
          type="checkbox"
          @change="emit('update:showReasoning', ($event.target as HTMLInputElement).checked)"
        />
        AI reasoning
      </label>
      <label v-if="canShowTalk" class="reasoning-toggle">
        <input
          :checked="showTalk === true"
          type="checkbox"
          @change="emit('update:showTalk', ($event.target as HTMLInputElement).checked)"
        />
        Table talk
      </label>
      <!-- Header controls a host view adds, e.g. the player's "Copy report". -->
      <slot name="actions" />
      <span class="hint">Click line to jump</span>
    </div>
    <div ref="scroller" class="scroller">
      <template v-for="line in lines" :key="line.sequence">
        <p
          class="line"
          :class="[line.emphasis, { active: activeSequence === line.sequence }]"
          @click="emit('selectSequence', line.sequence, line.turn)"
        >
          <span class="turn">T{{ line.turn }}</span>
          <span class="actor">{{ line.actorSeat ?? '--' }}</span>
          <span class="text">{{ line.text }}</span>
        </p>
        <p
          v-for="(note, index) in notesFor(line.sequence)"
          :key="`${line.sequence}-${index}`"
          class="note"
          :class="{ fallback: note.source === 'fallback', strategy: note.kind === 'strategy' }"
        >
          <span class="note-source">{{ note.kind === 'strategy' ? 'plan' : note.source }}</span>
          <span class="note-text">{{ note.text }}</span>
        </p>
        <p
          v-for="(said, index) in talkFor(line.sequence)"
          :key="`${line.sequence}-talk-${index}`"
          class="talk"
          :class="said.message.kind"
        >
          <span class="note-source">table</span>
          <span class="note-text">{{ said.text }}</span>
        </p>
      </template>
      <p
        v-for="(said, index) in trailingTalk"
        :key="`trailing-talk-${index}`"
        class="talk"
        :class="said.message.kind"
      >
        <span class="note-source">table</span>
        <span class="note-text">{{ said.text }}</span>
      </p>
      <p v-if="lines.length === 0" class="empty">nothing yet</p>
      <p v-else-if="showReasoning === true && !hasAnyReasoning" class="empty">
        no AI reasoning recorded yet
      </p>
    </div>
  </div>
</template>

<style scoped>
.log {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  padding: 0.4rem 0.5rem;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.3rem;
}
h3 {
  margin: 0;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.hint {
  font-size: 0.6rem;
  color: var(--muted);
  font-style: italic;
}
.reasoning-toggle {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-left: auto;
  margin-right: 0.6rem;
  font-size: 0.62rem;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}
.reasoning-toggle input {
  margin: 0;
  cursor: pointer;
}
.scroller {
  overflow-y: auto;
  flex: 1;
  min-height: 8rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem;
  line-height: 1.5;
}
.line {
  margin: 0;
  display: flex;
  gap: 0.5rem;
  padding: 0.1rem 0.2rem;
  border-radius: 2px;
  cursor: pointer;
  transition: background 80ms ease;
}
.line:hover {
  background: var(--surface-2);
}
.line.active {
  background: rgb(96 165 250 / 0.18);
  border-left: 2px solid var(--accent);
}
.turn,
.actor {
  color: var(--muted);
  white-space: nowrap;
}
.line.turn {
  margin-top: 0.3rem;
  color: var(--accent);
  font-weight: 700;
}
.line.elimination .text {
  color: var(--warn);
  font-weight: 700;
}
.line.warning .text {
  color: var(--danger);
  font-weight: 700;
}
/* Reasoning is commentary on the line above it: indented, dimmed, and never mistakable for an
   action the engine actually took. */
.note {
  margin: 0 0 0.15rem;
  padding: 0.05rem 0.2rem 0.05rem 2.1rem;
  display: flex;
  gap: 0.4rem;
  font-size: 0.66rem;
  font-style: italic;
  color: var(--muted);
  border-left: 2px solid var(--line);
  margin-left: 0.5rem;
}
.note-source {
  color: var(--accent);
  opacity: 0.7;
  white-space: nowrap;
}
.note.strategy {
  border-left-color: var(--accent);
}
/* Brief §13 wants fallbacks unmissable — a fallback's reasoning is where you look to find out
   why the model lost the plot, so it keeps the same red the log line uses. */
.note.fallback {
  border-left-color: var(--danger);
}
.note.fallback .note-source {
  color: var(--danger);
  opacity: 1;
  font-weight: 700;
}
/* Table talk (ADR 0035) sits like a note but reads as speech, not reasoning: upright, and a
   breach stands out the way a fallback does. */
.talk {
  margin: 0 0 0.15rem 0.5rem;
  padding: 0.05rem 0.2rem 0.05rem 2.1rem;
  display: flex;
  gap: 0.4rem;
  font-size: 0.66rem;
  color: var(--text);
  border-left: 2px dashed var(--accent);
}
.talk.breach {
  border-left-color: var(--danger);
}
.talk.breach .note-source {
  color: var(--danger);
  opacity: 1;
}
.empty {
  color: var(--muted);
  font-style: italic;
}
</style>
