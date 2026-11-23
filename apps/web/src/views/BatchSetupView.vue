<script setup lang="ts">
/**
 * New batch (redesign plan, phase 7): a run name and seed, then one card per scenario (how many
 * games, which bots, what sits in each seat) and the one action that starts the run. The run is
 * queued by `POST /api/batches` and the page moves on to its results.
 */
import PageTitle from '../components/shell/PageTitle.vue';
import PageFoot from '../components/shell/PageFoot.vue';
import { computed, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import type { BatchSpec, ProviderKind, SeatSource } from '@mtg/shared';
import { MAX_BATCH_NAME_LENGTH } from '@mtg/shared';
import { PROVIDER_LABELS } from '../lib/providerLabels';
import { SEAT_LETTERS, plural } from '../lib/batchModel';

const MAX_TOTAL_GAMES = 100;

interface DraftScenario {
  id: string;
  name: string;
  games: number;
  providerKind: ProviderKind;
  reflectionEnabled: boolean;
  seats: string[];
}
const router = useRouter();
const runName = ref('');
const seed = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);
/** Ids are never reused, so removing a scenario and adding another cannot collide. */
let counter = 0;
function makeScenario(): DraftScenario {
  counter += 1;
  return {
    id: `scenario-${counter}`,
    name: `Scenario ${counter}`,
    games: 3,
    providerKind: 'random',
    reflectionEnabled: false,
    seats: ['', '', '', ''],
  };
}
const scenarios = ref<DraftScenario[]>([makeScenario()]);
function addScenario(): void {
  scenarios.value.push(makeScenario());
}
function removeScenario(index: number): void {
  if (scenarios.value.length > 1) scenarios.value.splice(index, 1);
}
function setGames(scenario: DraftScenario, value: number): void {
  scenario.games = Math.min(MAX_TOTAL_GAMES, Math.max(1, Math.floor(Number(value) || 1)));
}
function pickProvider(scenario: DraftScenario): void {
  if (scenario.providerKind !== 'ai') scenario.reflectionEnabled = false;
}
/** A blank seat is a generated deck, an http(s) address is a deck URL, anything else a pasted list. */
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
const totalText = computed(
  () => `${plural(totalGames.value, 'game')} across ${plural(scenarios.value.length, 'scenario')}`,
);
const startLabel = computed(() =>
  submitting.value ? 'Starting…' : `Run ${plural(totalGames.value, 'game')}`,
);

async function start(): Promise<void> {
  error.value = null;
  if (totalGames.value < 1 || totalGames.value > MAX_TOTAL_GAMES) {
    error.value = `Choose between 1 and ${MAX_TOTAL_GAMES} total games.`;
    return;
  }
  submitting.value = true;
  const body: BatchSpec = {
    ...(runName.value.trim() !== '' ? { name: runName.value.trim() } : {}),
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
    <header class="top">
      <PageTitle place="II. Records · b. Batch runs" hide-kicker>New batch</PageTitle>
      <RouterLink to="/batch" class="dt-btn">All batch runs</RouterLink>
    </header>

    <section class="run-fields" aria-label="The run">
      <label class="dt-field"
        ><span>Run name <em>(optional)</em></span
        ><input
          v-model="runName"
          type="text"
          :maxlength="MAX_BATCH_NAME_LENGTH"
          placeholder="Named after its scenarios when blank"
      /></label>
      <label class="dt-field"
        ><span>Batch seed <em>(optional)</em></span
        ><input v-model="seed" type="text" placeholder="A fresh seed when blank"
      /></label>
    </section>

    <section
      v-for="(scenario, scenarioIndex) in scenarios"
      :key="scenario.id"
      class="scenario"
      :aria-label="`Scenario ${scenarioIndex + 1}`"
    >
      <header class="sc-head">
        <label class="dt-field sc-name"
          ><span>Scenario {{ scenarioIndex + 1 }}</span
          ><input
            v-model="scenario.name"
            type="text"
            :aria-label="`Name of scenario ${scenarioIndex + 1}`"
        /></label>
        <button
          v-if="scenarios.length > 1"
          type="button"
          class="dt-btn small"
          :aria-label="`Remove scenario ${scenarioIndex + 1}`"
          @click="removeScenario(scenarioIndex)"
        >
          Remove
        </button>
      </header>

      <div class="sc-options">
        <div class="dt-field">
          <span>Games</span>
          <div class="stepper" role="group" :aria-label="`Games in scenario ${scenarioIndex + 1}`">
            <button
              type="button"
              aria-label="Fewer games"
              :disabled="scenario.games <= 1"
              @click="setGames(scenario, scenario.games - 1)"
            >
              −
            </button>
            <input
              :value="scenario.games"
              type="number"
              min="1"
              :max="MAX_TOTAL_GAMES"
              inputmode="numeric"
              aria-label="Games"
              @change="setGames(scenario, Number(($event.target as HTMLInputElement).value))"
            />
            <button
              type="button"
              aria-label="More games"
              :disabled="scenario.games >= MAX_TOTAL_GAMES"
              @click="setGames(scenario, scenario.games + 1)"
            >
              +
            </button>
          </div>
        </div>
        <label class="dt-field"
          ><span>Provider</span
          ><select v-model="scenario.providerKind" @change="pickProvider(scenario)">
            <option value="random">{{ PROVIDER_LABELS.random }}</option>
            <option value="ai">{{ PROVIDER_LABELS.ai }}</option>
          </select></label
        >
        <label class="check" :class="{ off: scenario.providerKind !== 'ai' }"
          ><input
            v-model="scenario.reflectionEnabled"
            type="checkbox"
            :disabled="scenario.providerKind !== 'ai'"
          />
          <span>Post-game commentary</span>
          <small v-if="scenario.providerKind !== 'ai'">AI bots only</small></label
        >
      </div>

      <p class="hint">
        Each seat may be left blank for a generated deck, or hold a deck URL or a pasted decklist.
      </p>
      <div class="seats">
        <label v-for="(letter, seat) in SEAT_LETTERS" :key="letter" class="dt-field seat"
          ><span>Seat {{ letter }}</span
          ><textarea
            v-model="scenario.seats[seat]"
            rows="3"
            placeholder="Blank for a generated deck, a URL, or a decklist"
          ></textarea>
        </label>
      </div>
    </section>

    <div class="add-row">
      <button type="button" class="dt-btn" @click="addScenario">Add scenario</button>
    </div>

    <div class="start-bar">
      <p v-if="error" class="dt-note danger" role="alert">{{ error }}</p>
      <div class="start-row">
        <span class="total" aria-live="polite">{{ totalText }}</span>
        <button type="button" class="dt-btn-primary" :disabled="submitting" @click="start">
          {{ startLabel }} <span class="dt-arr" aria-hidden="true" />
        </button>
      </div>
    </div>

    <PageFoot place="II. Records · b. Batch runs" />
  </section>
</template>

<style scoped>
.batch-setup {
  width: 100%;
  box-sizing: border-box;
  padding: 1.75rem 3rem 0;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  font-family: var(--font-body);
  color: var(--ink);
}
p {
  margin: 0;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem 2rem;
}
.top :deep(.page-title) {
  flex: 1 1 18rem;
}
.dt-field input[type='text'] {
  min-height: 42px;
  padding: 0.35rem 0.1rem;
  border: 0;
  border-bottom: 1px solid var(--ink);
  background: transparent;
  font-size: 1rem;
}
.dt-field em {
  font-style: normal;
  text-transform: none;
  letter-spacing: 0;
}
.run-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.5rem 2.5rem;
}
.scenario {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.1rem 1.25rem 1.25rem;
  border: 1px solid var(--ink);
  background: var(--paper-2);
}
.sc-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
}
.sc-name {
  flex: 1 1 auto;
  min-width: 0;
}
.sc-options {
  display: grid;
  grid-template-columns: 11rem minmax(12rem, 16rem) minmax(0, 1fr);
  gap: 1rem 2rem;
  align-items: end;
}
.stepper {
  display: flex;
  align-items: stretch;
  min-height: 42px;
  border-bottom: 1px solid var(--ink);
}
.stepper button {
  width: 42px;
  border: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 1.1rem;
  cursor: pointer;
  transition:
    background-color 0.3s var(--ease),
    color 0.3s var(--ease);
}
.stepper button:hover:not(:disabled) {
  background: var(--ink);
  color: var(--paper);
}
.stepper button:disabled {
  color: var(--muted);
  cursor: default;
}
.stepper input {
  flex: 1;
  min-width: 0;
  border-bottom: 0;
  text-align: center;
  font-variant-numeric: tabular-nums;
  appearance: textfield;
  -moz-appearance: textfield;
}
.stepper input::-webkit-outer-spin-button,
.stepper input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-height: 42px;
  font-size: 0.85rem;
  cursor: pointer;
}
.check input {
  width: 1.1rem;
  height: 1.1rem;
  margin: 0;
  accent-color: var(--ink);
}
.check.off {
  color: var(--muted);
  cursor: default;
}
.check small {
  font-size: 0.7rem;
  color: var(--muted);
}
.hint {
  font-size: 0.75rem;
  color: var(--muted);
}
.seats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
}
.seat textarea {
  background: var(--paper);
}
.add-row {
  display: flex;
}
.start-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin: 0 -3rem;
  padding: 0.9rem 3rem;
  border-top: 1px solid var(--ink);
  background: var(--paper-2);
}
.start-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem 1.5rem;
}
.total {
  font-size: 0.85rem;
}
:deep(.dt-footline) {
  margin-bottom: 1.5rem;
}
@media (max-width: 900px) {
  .sc-options {
    grid-template-columns: 1fr 1fr;
  }
  .check {
    grid-column: 1 / -1;
  }
  .seats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .batch-setup {
    padding: 1.25rem 1rem 0;
  }
  .run-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .scenario {
    padding: 0.9rem;
  }
  .start-bar {
    margin: 0 -1rem;
    padding: 0.8rem 1rem;
  }
  .start-row .dt-btn-primary {
    flex: 1 1 100%;
  }
}
@media (max-width: 520px) {
  .sc-options,
  .seats {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
