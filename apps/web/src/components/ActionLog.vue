<script setup lang="ts">
/**
 * The spectator action log (brief §10.2): chronological, minimal format, **no AI reasoning** —
 * reasoning notes are debug-log-only (brief §7.3, §15). Lines arrive pre-formatted from the
 * engine so the UI never interprets an event.
 */
import { nextTick, ref, watch } from 'vue';
import type { SpectatorLogLine } from '@mtg/shared';

const props = defineProps<{ lines: SpectatorLogLine[]; follow: boolean }>();

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
</script>

<template>
  <div class="log">
    <h3>Action log</h3>
    <div ref="scroller" class="scroller">
      <p
        v-for="line in lines"
        :key="line.sequence"
        class="line"
        :class="line.emphasis"
      >
        <span class="turn">T{{ line.turn }}</span>
        <span class="actor">{{ line.actorSeat ?? '--' }}</span>
        <span class="text">{{ line.text }}</span>
      </p>
      <p v-if="lines.length === 0" class="empty">nothing yet</p>
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
h3 {
  margin: 0 0 0.3rem;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
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
.empty {
  color: var(--muted);
  font-style: italic;
}
</style>
