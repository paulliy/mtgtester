<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { CardTestScenarioMetadata } from '@mtg/shared';
import { useGameStore } from '../stores/game';

const store = useGameStore();
const router = useRouter();

const scenarios = ref<CardTestScenarioMetadata[]>([]);
const catalogError = ref<string | null>(null);
const selectedScenarioId = ref<string | null>(null);

const starting = computed(() => store.gameId === null && store.connection !== 'closed');

const selected = computed(
  () => scenarios.value.find((entry) => entry.id === selectedScenarioId.value) ?? null,
);

onMounted(async () => {
  try {
    const response = await fetch('/api/card-test-scenarios');
    if (!response.ok) {
      catalogError.value = `Scenario catalog unavailable (${response.status}). Is the server running with --card-test-lab?`;
      return;
    }
    const body = (await response.json()) as { scenarios: CardTestScenarioMetadata[] };
    scenarios.value = body.scenarios;
    selectedScenarioId.value = body.scenarios[0]?.id ?? null;
  } catch {
    catalogError.value =
      'Scenario catalog unavailable. Is the server running with --card-test-lab?';
  }
});

watch(
  () => store.cardTestScenario?.id,
  (id) => {
    if (id !== undefined && id !== null) void router.push('/game');
  },
);

function start(): void {
  if (selectedScenarioId.value === null) return;
  store.startCardTestScenario(selectedScenarioId.value);
}
</script>

<template>
  <section class="lab">
    <p class="eyebrow">Development-only deterministic viewer</p>
    <h1>Card Test Lab</h1>
    <p>
      Arranged positions that use the production engine, server decision protocol, and player
      controls. Only the starting state is prepared. Pick a scenario, run it, and resolve the
      scripted interactive moment like a normal game.
    </p>

    <p v-if="catalogError" class="error">{{ catalogError }}</p>

    <div v-else-if="scenarios.length > 0" class="picker">
      <label for="scenario-select">Scenario</label>
      <select id="scenario-select" v-model="selectedScenarioId">
        <option v-for="entry in scenarios" :key="entry.id" :value="entry.id">
          {{ entry.title }}
        </option>
      </select>
    </div>

    <template v-if="selected">
      <h2>{{ selected.title }}</h2>
      <p>
        <strong>Oracle sha256:</strong> <code>{{ selected.oracleSha256 }}</code>
      </p>
      <ol>
        <li v-for="step in selected.instructions" :key="step">{{ step }}</li>
      </ol>
      <aside>Expected: {{ selected.expectedOutcome }}</aside>
    </template>

    <button type="button" :disabled="starting || selectedScenarioId === null" @click="start">
      {{ starting ? 'Starting…' : 'Run scenario' }}
    </button>
    <p v-for="error in store.errors" :key="error" class="error">{{ error }}</p>
  </section>
</template>

<style scoped>
.lab {
  width: min(44rem, calc(100% - 2rem));
  margin: 2rem auto;
  display: grid;
  gap: 1rem;
}
.eyebrow {
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.75rem;
}
h1,
h2,
p {
  margin: 0;
}
.picker {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.picker select {
  flex: 1;
  min-width: 0;
}
aside {
  padding: 0.8rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
}
button {
  justify-self: start;
}
.error {
  color: var(--danger, #d65b5b);
}
</style>
