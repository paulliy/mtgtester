<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { BatchSpec, ProviderKind, SeatSource } from '@mtg/shared';
import { PROVIDER_LABELS } from '../lib/providerLabels';

interface DraftScenario {
  id: string;
  name: string;
  games: number;
  providerKind: ProviderKind;
  reflectionEnabled: boolean;
  seats: string[];
}
const router = useRouter();
const seed = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);
const scenarios = ref<DraftScenario[]>([makeScenario(1)]);
function makeScenario(index: number): DraftScenario {
  return {
    id: `scenario-${index}`,
    name: `Scenario ${index}`,
    games: 3,
    providerKind: 'random',
    reflectionEnabled: false,
    seats: ['', '', '', ''],
  };
}
function addScenario(): void {
  scenarios.value.push(makeScenario(scenarios.value.length + 1));
}
function removeScenario(index: number): void {
  if (scenarios.value.length > 1) scenarios.value.splice(index, 1);
}
function source(raw: string): SeatSource {
  const value = raw.trim();
  if (value === '') return { kind: 'pool' };
  return /^https?:\/\//i.test(value)
    ? { kind: 'url', url: value }
    : { kind: 'plaintext', text: value };
}
const totalGames = computed(() =>
  scenarios.value.reduce((sum, item) => sum + Math.max(0, Math.floor(item.games || 0)), 0),
);
async function start(): Promise<void> {
  error.value = null;
  if (totalGames.value < 1 || totalGames.value > 100) {
    error.value = 'Choose between 1 and 100 total games.';
    return;
  }
  submitting.value = true;
  const body: BatchSpec = {
    ...(seed.value.trim() !== '' ? { seed: seed.value.trim() } : {}),
    scenarios: scenarios.value.map((item) => ({
      id: item.id.trim(),
      name: item.name.trim(),
      games: Math.floor(item.games),
      providerKind: item.providerKind,
      reflectionEnabled: item.reflectionEnabled,
      seats: item.seats.map(source),
    })),
  };
  try {
    const response = await fetch('/api/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { batchId?: string; message?: string };
    if (!response.ok || payload.batchId === undefined)
      throw new Error(payload.message ?? 'Could not start batch.');
    await router.push(`/batch/${encodeURIComponent(payload.batchId)}`);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="batch-setup">
    <header class="batch-header">
      <div>
        <p class="eyebrow">Commander simulator</p>
        <h1>Batch simulations</h1>
        <p class="hint">Run named spectator scenarios sequentially and collect durable results.</p>
      </div>
      <strong>{{ totalGames }} games</strong>
    </header>
    <section class="panel">
      <label class="field-label"
        >Batch seed <span>(optional)</span
        ><input v-model="seed" type="text" placeholder="fresh seed when blank"
      /></label>
    </section>
    <section
      v-for="(scenario, scenarioIndex) in scenarios"
      :key="scenario.id"
      class="panel scenario"
    >
      <header class="scenario-head">
        <div>
          <span class="eyebrow">Scenario {{ scenarioIndex + 1 }}</span
          ><input v-model="scenario.name" class="scenario-name" />
        </div>
        <button v-if="scenarios.length > 1" type="button" @click="removeScenario(scenarioIndex)">
          Remove
        </button>
      </header>
      <div class="scenario-options">
        <label class="field-label">Id<input v-model="scenario.id" type="text" /></label
        ><label class="field-label"
          >Games<input v-model.number="scenario.games" type="number" min="1" max="100" /></label
        ><label class="field-label"
          >Provider<select v-model="scenario.providerKind">
            <option value="random">{{ PROVIDER_LABELS.random }}</option>
            <option value="ai">{{ PROVIDER_LABELS.ai }}</option>
          </select></label
        ><label class="check"
          ><input
            v-model="scenario.reflectionEnabled"
            type="checkbox"
            :disabled="scenario.providerKind !== 'ai'"
          />
          post-game commentary</label
        >
      </div>
      <p class="hint">
        Each seat may be blank for a generated supported-pool deck, a URL, or a pasted decklist.
      </p>
      <div class="seats">
        <label v-for="seat in 4" :key="seat" class="field-label"
          >P{{ seat
          }}<textarea
            v-model="scenario.seats[seat - 1]"
            rows="3"
            :placeholder="`blank for generated deck, URL, or decklist`"
          ></textarea>
        </label>
      </div>
    </section>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="actions">
      <button type="button" @click="addScenario">Add scenario</button
      ><button type="button" class="primary" :disabled="submitting" @click="start">
        {{ submitting ? 'Starting…' : 'Start batch →' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.batch-setup {
  max-width: 1000px;
  margin: 0 auto;
  padding: 1.25rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.batch-header,
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 1rem;
}
.batch-header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: start;
}
.batch-header h1 {
  margin: 0.25rem 0;
}
.eyebrow,
.field-label {
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
}
.hint {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
}
.field-label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.field-label span {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
}
.scenario {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.scenario-head {
  display: flex;
  justify-content: space-between;
  align-items: start;
}
.scenario-name {
  margin-top: 0.35rem;
  font-size: 1.1rem;
  font-weight: 600;
}
.scenario-options {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1.5fr;
  gap: 0.6rem;
  align-items: end;
}
.scenario-options select {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--line);
  padding: 0.35rem;
}
.check {
  display: flex;
  gap: 0.35rem;
  align-items: center;
  color: var(--muted);
  font-size: 11px;
}
.seats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.6rem;
}
.actions {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}
.primary {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
.error {
  color: var(--danger);
  border-left: 2px solid var(--danger);
  padding-left: 0.5rem;
}
@media (max-width: 700px) {
  .scenario-options,
  .seats {
    grid-template-columns: 1fr 1fr;
  }
  .batch-header {
    display: block;
  }
}
</style>
