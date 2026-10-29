<script setup lang="ts">
/**
 * Brief §7.7 step 2: the AI produced an invalid response twice and the user is watching, so
 * the choice is surfaced to them. They have five seconds; after that the server applies the
 * safest legal action and logs it as a fallback.
 *
 * This is not a playable seat (brief §15) — it is an override on a broken response.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import type { DecisionPendingPayload } from '../lib/protocol';

const props = defineProps<{ pending: DecisionPendingPayload }>();
const emit = defineEmits<{ (event: 'choose', actionId: number): void }>();

const remainingMs = ref(props.pending.timeoutMs);
let timer: ReturnType<typeof setInterval> | null = null;

watch(
  () => props.pending.request.requestId,
  () => {
    remainingMs.value = props.pending.timeoutMs;
  },
  { immediate: true },
);

timer = setInterval(() => {
  remainingMs.value = Math.max(0, remainingMs.value - 100);
}, 100);

onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});

const seconds = computed(() => (remainingMs.value / 1000).toFixed(1));
</script>

<template>
  <div class="held">
    <header>
      <strong>AI response rejected — choose an action</strong>
      <span class="clock">{{ seconds }}s before the safest legal action is used</span>
    </header>
    <p class="prompt">
      {{ pending.request.decidingPlayer }} · {{ pending.request.decisionType }} ·
      {{ pending.request.prompt }}
    </p>
    <p class="invalid">
      what the model returned: <code>{{ pending.invalidResponse }}</code>
    </p>
    <ul>
      <li v-for="action in pending.request.legalActions" :key="action.id">
        <button type="button" @click="emit('choose', action.id)">
          {{ action.id }}. {{ action.description }}
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.held {
  border: 2px solid var(--danger);
  border-radius: 4px;
  background: var(--surface);
  padding: 0.6rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  font-size: 0.82rem;
}
.clock {
  color: var(--warn);
  font-variant-numeric: tabular-nums;
}
.prompt {
  margin: 0;
  font-size: 0.78rem;
}
.invalid {
  margin: 0;
  font-size: 0.72rem;
  color: var(--muted);
  word-break: break-all;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  max-height: 12rem;
  overflow-y: auto;
}
button {
  font-size: 0.75rem;
  text-align: left;
}
</style>
