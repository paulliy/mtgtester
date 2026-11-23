<script setup lang="ts">
import PageTitle from '../components/shell/PageTitle.vue';
import PageFoot from '../components/shell/PageFoot.vue';
import { computed, ref, watch } from 'vue';
import type { DebugFlags } from '@mtg/shared';
import { useRoute } from 'vue-router';
import { useGameStore } from '../stores/game';

interface DebugEvent {
  sequence: number;
  turn: number;
  category: string;
  message: string;
  data_json: string | null;
}
interface AiCall {
  sequence: number;
  seat: number;
  model: string;
  prompt_tokens: number;
  response_tokens: number;
  was_retry: number;
  was_fallback: number;
  latency_ms: number;
  cost_usd: number | null;
  source: string;
  request_json: string;
  response_json: string;
}
interface DebugData {
  debugEvents: DebugEvent[];
  aiCalls: AiCall[];
}
const game = useGameStore();
const route = useRoute();
/** A `?gameId=` link (the Stats page's "Open last game in Debug") wins; otherwise the live game. */
const activeGameId = computed<string | null>(() => {
  const queried = route.query['gameId'];
  return typeof queried === 'string' && queried !== '' ? queried : game.gameId;
});
const data = ref<DebugData | null>(null);
const error = ref<string | null>(null);
const turn = ref<number | null>(null);
const category = ref('');
const selected = ref<AiCall | null>(null);
const flags = computed(() => game.debugFlags);
function toggle(key: keyof DebugFlags, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  game.setDebugFlags({ ...flags.value, [key]: checked });
}

async function load(): Promise<void> {
  if (activeGameId.value === null) {
    data.value = null;
    return;
  }
  try {
    const response = await fetch(`/api/games/${encodeURIComponent(activeGameId.value)}/debug`);
    if (!response.ok)
      throw new Error(
        ((await response.json()) as { message?: string }).message ?? 'Could not load debug data.',
      );
    data.value = (await response.json()) as DebugData;
    error.value = null;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}

watch(activeGameId, () => void load(), { immediate: true });
const categories = computed(() => [
  ...new Set(data.value?.debugEvents.map((entry) => entry.category) ?? []),
]);
const entries = computed(
  () =>
    data.value?.debugEvents.filter(
      (entry) =>
        (turn.value === null || entry.turn === turn.value) &&
        (!category.value || entry.category === category.value),
    ) ?? [],
);
function exportGame(): void {
  if (activeGameId.value !== null)
    window.location.assign(`/api/games/${encodeURIComponent(activeGameId.value)}/export`);
}
</script>

<template>
  <section class="debug">
    <header>
      <div>
        <PageTitle place="III. Workshop · c. Debug">Debug panel</PageTitle>
        <p v-if="activeGameId">Game {{ activeGameId }}</p>
        <p v-else>Start a recorded game to inspect diagnostics.</p>
      </div>
      <div>
        <button :disabled="!activeGameId" @click="load">Refresh</button
        ><button :disabled="!activeGameId" @click="exportGame">Export JSON</button>
      </div>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="toggles">
      <label v-for="(value, key) in flags" :key="key"
        ><input
          :checked="value"
          type="checkbox"
          @change="toggle(key as keyof DebugFlags, $event)"
        />
        {{ key }}</label
      >
    </div>
    <div v-if="data" class="filters">
      <label>Turn <input v-model.number="turn" type="number" min="0" placeholder="All" /></label
      ><label
        >Event type
        <select v-model="category">
          <option value="">All</option>
          <option v-for="item in categories" :key="item" :value="item">{{ item }}</option>
        </select></label
      ><span>{{ entries.length }} entries</span>
    </div>
    <p v-if="game.liveDebug.length > 0" class="live">
      Streaming {{ game.liveDebug.length }} live engine entries.
    </p>
    <div v-if="data" class="grid">
      <section>
        <h2>Engine log</h2>
        <ol>
          <li v-for="entry in entries" :key="entry.sequence">
            <b>T{{ entry.turn }}</b> <code>{{ entry.category }}</code> {{ entry.message }}
            <pre v-if="entry.data_json">{{ entry.data_json }}</pre>
          </li>
        </ol>
      </section>
      <section>
        <h2>AI calls</h2>
        <button
          v-for="call in data.aiCalls"
          :key="call.sequence"
          class="call"
          :class="{ fallback: call.was_fallback }"
          @click="selected = call"
        >
          #{{ call.sequence }} P{{ call.seat }} · {{ call.source }} · {{ call.model }} ·
          {{ call.prompt_tokens + call.response_tokens }} tok · {{ call.latency_ms }}ms<span
            v-if="call.was_fallback"
          >
            FALLBACK</span
          >
        </button>
      </section>
    </div>
    <section v-if="selected" class="detail">
      <header>
        <h2>AI call #{{ selected.sequence }}</h2>
        <button @click="selected = null">Close</button>
      </header>
      <p>
        Retry: {{ Boolean(selected.was_retry) }} · Fallback: {{ Boolean(selected.was_fallback) }} ·
        Cost: ${{ selected.cost_usd ?? 0 }}
      </p>
      <h3>Request</h3>
      <pre>{{ selected.request_json }}</pre>
      <h3>Response</h3>
      <pre>{{ selected.response_json }}</pre>
    </section>
    <PageFoot place="III. Workshop · c. Debug" />
  </section>
</template>

<style scoped>
.debug {
  max-width: 1300px;
  margin: 0 auto;
  padding: 1rem;
}
header {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
}
header button + button {
  margin-left: 0.4rem;
}
h1,
h2,
h3,
p {
  margin: 0;
}
p {
  color: var(--muted);
}
.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  margin-top: 0.8rem;
  font-size: 0.82rem;
}
.filters {
  display: flex;
  align-items: end;
  gap: 0.7rem;
  margin: 0.8rem 0;
}
.filters input,
.filters select {
  display: block;
  width: auto;
  margin-top: 0.2rem;
}
.grid {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 0.8rem;
}
.grid section,
.detail {
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 0.7rem;
  min-width: 0;
}
ol {
  max-height: 60vh;
  overflow: auto;
  margin: 0.6rem 0 0;
  padding-left: 2rem;
}
li {
  margin: 0.35rem 0;
}
code {
  color: var(--accent);
}
pre {
  white-space: pre-wrap;
  overflow: auto;
  max-height: 15rem;
  background: var(--surface-2);
  padding: 0.45rem;
  font-size: 0.78rem;
}
.call {
  display: block;
  width: 100%;
  text-align: left;
  margin: 0.35rem 0;
}
.fallback {
  border-color: var(--danger);
  color: var(--danger);
  font-weight: 700;
}
.detail {
  margin-top: 0.8rem;
}
.error {
  color: var(--danger);
}
.live {
  color: var(--ok);
}
@media (max-width: 800px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
