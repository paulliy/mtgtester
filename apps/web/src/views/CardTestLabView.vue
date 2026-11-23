<script setup lang="ts">
/**
 * The Card Test Lab (dev-only), laid out as the approved single-card design (redesign plan, phase
 * 4d): a card finder on the left, the chosen card and its clauses in the middle, and what the lab
 * records as evidence on the right. Scenarios come from `/api/card-test-scenarios`, grouped by
 * `oracleSha256` (`lib/cardLabModel.ts`); the card's name, status, clauses and evidence come from
 * `/api/card-test-lab/cards`, which reads the verification manifest and the audit ledger by hash.
 *
 * The server reports no pass or fail for a scenario: running one opens the real board and the
 * player resolves it by hand. So a scenario is "Ran" (started in this browser session) or "Not
 * run", and the evidence list shows only what the manifest or ledger holds; the rest reads
 * "Not recorded".
 */
import PageTitle from '../components/shell/PageTitle.vue';
import PageFoot from '../components/shell/PageFoot.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { CardTestLabCard, CardTestScenarioMetadata } from '@mtg/shared';
import { useGameStore } from '../stores/game';
import {
  evidenceRows,
  filterCards,
  groupScenariosByCard,
  parseQueue,
  startQueue,
  type LabCard,
  type RunQueue,
} from '../lib/cardLabModel';

const store = useGameStore();
const router = useRouter();

const scenarios = ref<CardTestScenarioMetadata[]>([]);
const labCards = ref<Map<string, CardTestLabCard>>(new Map());
const catalogError = ref<string | null>(null);
const selectedScenarioId = ref<string | null>(null);
const query = ref('');

/** The list shows this many cards at a time; typing narrows it. */
const LIST_LIMIT = 120;
const RAN_KEY = 'decktank.cardLab.ran';
const QUEUE_KEY = 'decktank.cardLab.queue';

/** Scenario IDs started in this browser session. A start is the only signal the lab has. */
const ran = ref<Set<string>>(new Set());
const queue = ref<RunQueue | null>(null);

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* The page works without storage; it only forgets what ran. */
  }
}
function loadRan(): Set<string> {
  const text = readStorage(RAN_KEY);
  if (text === null) return new Set();
  try {
    const value: unknown = JSON.parse(text);
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}
function persist(): void {
  writeStorage(RAN_KEY, JSON.stringify([...ran.value]));
  writeStorage(QUEUE_KEY, queue.value === null ? null : JSON.stringify(queue.value));
}

const starting = computed(() => store.gameId === null && store.connection !== 'closed');

const cards = computed(() =>
  groupScenariosByCard(
    scenarios.value,
    new Map(
      [...labCards.value.values()].flatMap((info): [string, string][] =>
        info.name === undefined ? [] : [[info.oracleSha256, info.name]],
      ),
    ),
  ),
);
const info = computed(() =>
  card.value === null ? undefined : labCards.value.get(card.value.oracleSha256),
);
const scenarioById = computed(() => new Map(scenarios.value.map((entry) => [entry.id, entry])));
const clauseRows = computed(() => {
  const current = info.value;
  if (current === undefined || !current.manifestPinned || current.clauses.length === 0) return null;
  return current.clauses.map((clause) => ({
    key: clause.id ?? clause.oracleText,
    clause,
    scenarios: clause.scenarioIds.flatMap((id) => scenarioById.value.get(id) ?? []),
  }));
});
const unmapped = computed(() =>
  (info.value?.unmappedScenarioIds ?? []).flatMap((id) => scenarioById.value.get(id) ?? []),
);
const statusText = computed(() => info.value?.implementationStatus ?? null);
const cardByScenario = computed(() => {
  const map = new Map<string, LabCard>();
  for (const card of cards.value) for (const entry of card.scenarios) map.set(entry.id, card);
  return map;
});
const selected = computed(
  () => scenarios.value.find((entry) => entry.id === selectedScenarioId.value) ?? null,
);
const card = computed(() =>
  selectedScenarioId.value === null
    ? null
    : (cardByScenario.value.get(selectedScenarioId.value) ?? null),
);

const matches = computed(() => filterCards(cards.value, query.value));
const visibleCards = computed(() => {
  const shown = matches.value.slice(0, LIST_LIMIT);
  const current = card.value;
  // The chosen card stays on the list even when the search or the cut leaves it out.
  if (current !== null && !shown.includes(current)) shown.unshift(current);
  return shown;
});
const hiddenCount = computed(() => Math.max(0, matches.value.length - LIST_LIMIT));

function ranCount(target: LabCard): number {
  return target.scenarios.filter((entry) => ran.value.has(entry.id)).length;
}
function cardTag(target: LabCard): { text: string; ran: boolean } {
  const count = ranCount(target);
  return count === 0
    ? {
        text: `${target.scenarios.length} ${target.scenarios.length === 1 ? 'scenario' : 'scenarios'}`,
        ran: false,
      }
    : { text: `${count} of ${target.scenarios.length} ran`, ran: true };
}

const cardRanCount = computed(() => (card.value === null ? 0 : ranCount(card.value)));
const queueForCard = computed(() =>
  card.value !== null &&
  queue.value !== null &&
  queue.value.oracleSha256 === card.value.oracleSha256 &&
  queue.value.remaining.length > 0
    ? queue.value
    : null,
);
const runAllLabel = computed(() => {
  if (starting.value) return 'Starting…';
  return queueForCard.value === null ? 'Run all scenarios' : 'Run next scenario';
});
const runNote = computed(() => {
  const current = card.value;
  if (current === null) return '';
  const pending = queueForCard.value;
  if (pending !== null)
    return `${pending.total - pending.remaining.length} of ${pending.total} started. Come back here to run the next.`;
  return cardRanCount.value === 0
    ? 'Nothing from this card has run in this session.'
    : `${cardRanCount.value} of ${current.scenarios.length} started in this session.`;
});

const evidence = computed(() =>
  card.value === null
    ? []
    : evidenceRows(card.value.oracleSha256, card.value.scenarios.length, info.value),
);
const isViewerScenario = (id: string): boolean => info.value?.ledger?.viewerScenarioId === id;

onMounted(async () => {
  ran.value = loadRan();
  queue.value = parseQueue(readStorage(QUEUE_KEY));
  // The card report is extra: without it names come from titles and evidence reads "Not recorded".
  const reportRequest = fetch('/api/card-test-lab/cards')
    .then(async (response) =>
      response.ok ? ((await response.json()) as { cards: CardTestLabCard[] }).cards : [],
    )
    .catch(() => [] as CardTestLabCard[]);
  try {
    const response = await fetch('/api/card-test-scenarios');
    if (!response.ok) {
      catalogError.value = `Scenario catalog unavailable (${response.status}). Is the server running with --card-test-lab?`;
      return;
    }
    const body = (await response.json()) as { scenarios: CardTestScenarioMetadata[] };
    labCards.value = new Map((await reportRequest).map((entry) => [entry.oracleSha256, entry]));
    scenarios.value = body.scenarios;
    // Coming back to a run in progress lands on the card it was running.
    const waiting = queue.value?.remaining[0];
    selectedScenarioId.value =
      waiting !== undefined && body.scenarios.some((entry) => entry.id === waiting)
        ? waiting
        : (body.scenarios[0]?.id ?? null);
  } catch {
    catalogError.value =
      'Scenario catalog unavailable. Is the server running with --card-test-lab?';
  }
});

watch(
  () => store.gameId,
  (gameId) => {
    if (gameId !== null) void router.push('/game');
  },
);

function pickCard(target: LabCard): void {
  selectedScenarioId.value = target.scenarios[0]?.id ?? null;
}

function launch(id: string): void {
  ran.value = new Set(ran.value).add(id);
  persist();
  store.startCardTestScenario(id);
}

function start(): void {
  if (selectedScenarioId.value === null) return;
  launch(selectedScenarioId.value);
}

function runAll(): void {
  const current = card.value;
  if (current === null || starting.value) return;
  const pending = queueForCard.value ?? startQueue(current);
  const next = pending.remaining[0];
  if (next === undefined) return;
  queue.value = { ...pending, remaining: pending.remaining.slice(1) };
  selectedScenarioId.value = next;
  launch(next);
}

function startOver(): void {
  queue.value = null;
  persist();
}
</script>

<template>
  <section class="lab">
    <header class="lab-head">
      <PageTitle place="III. Workshop · a. Card lab" hide-kicker>Card Test Lab</PageTitle>
      <p class="intro">
        Arranged positions that use the production engine, server decision protocol, and player
        controls. Only the starting state is prepared. Pick a scenario, run it, and resolve the
        scripted interactive moment like a normal game. Development only; each scenario replays the
        same way every time.
      </p>
    </header>

    <p v-if="catalogError" class="dt-note danger" role="alert">{{ catalogError }}</p>

    <div v-else-if="scenarios.length > 0 && card" class="cols">
      <!-- Find a card -->
      <nav class="finder dt-rise" aria-label="Cards">
        <label class="dt-field">
          <span>Find a card</span>
          <input v-model="query" type="search" placeholder="Card name" autocomplete="off" />
        </label>
        <ul class="card-list">
          <li v-for="entry in visibleCards" :key="entry.oracleSha256">
            <button
              type="button"
              class="card-row"
              :aria-pressed="entry === card"
              @click="pickCard(entry)"
            >
              <span class="card-row-name">{{ entry.name }}</span>
              <span class="tag" :class="{ ran: cardTag(entry).ran }">{{
                cardTag(entry).text
              }}</span>
            </button>
          </li>
        </ul>
        <p v-if="matches.length === 0" class="finder-note" role="status">
          No card in the catalog matches “{{ query.trim() }}”.
        </p>
        <p v-else-if="hiddenCount > 0" class="finder-note" role="status">
          {{ hiddenCount }} more cards. Keep typing to narrow the list.
        </p>
        <p class="finder-note">
          {{ cards.length }} cards, {{ scenarios.length }} scenarios in the catalog.
        </p>
      </nav>

      <!-- The card and its clauses -->
      <div class="centre">
        <div class="card-top">
          <div class="frame dt-rise" aria-hidden="true">
            <span class="frame-name">{{ card.name }}</span>
            <span class="frame-art"><i class="corner tl" /><i class="corner br" /></span>
            <span class="frame-pin">sha256 {{ card.oracleSha256.slice(0, 16) }}…</span>
          </div>
          <div class="card-facts">
            <div class="name-block">
              <h2 class="card-title"><span class="sr-only">Card </span>{{ card.name }}</h2>
              <div class="dt-ornament" aria-hidden="true"><span class="star" /></div>
            </div>
            <dl class="facts">
              <dt>Oracle pinned</dt>
              <dd class="sha">sha256 {{ card.oracleSha256 }}</dd>
              <dt>Scenarios</dt>
              <dd>{{ card.scenarios.length }}</dd>
              <dt>Status</dt>
              <dd v-if="statusText" class="status">{{ statusText }}</dd>
              <dd v-else class="muted">Not recorded</dd>
              <template v-if="info?.unsupportedReason">
                <dt>Unsupported</dt>
                <dd>{{ info.unsupportedReason }}</dd>
              </template>
              <dt>Seed</dt>
              <dd class="muted">Not recorded</dd>
            </dl>
            <div class="run-row">
              <button type="button" class="dt-btn run-all" :disabled="starting" @click="runAll">
                {{ runAllLabel }}
              </button>
              <span class="run-note" aria-live="polite">
                {{ runNote }}
                <button v-if="queueForCard" type="button" class="link" @click="startOver">
                  Start over
                </button>
              </span>
            </div>
          </div>
        </div>

        <section class="scenario" aria-label="Scenario">
          <div class="picker dt-field">
            <label for="scenario-select"><span>Scenario</span></label>
            <select id="scenario-select" v-model="selectedScenarioId">
              <option v-for="entry in scenarios" :key="entry.id" :value="entry.id">
                {{ entry.title }}
              </option>
            </select>
          </div>
          <template v-if="selected">
            <h3 class="scenario-title">{{ selected.title }}</h3>
            <ol class="steps">
              <li v-for="step in selected.instructions" :key="step">{{ step }}</li>
            </ol>
            <aside class="expected">Expected: {{ selected.expectedOutcome }}</aside>
            <div class="run-row">
              <button
                type="button"
                class="dt-btn-primary"
                :disabled="starting || selectedScenarioId === null"
                @click="start"
              >
                {{ starting ? 'Starting…' : 'Run scenario' }}
              </button>
              <span class="chip" :class="{ ran: ran.has(selected.id) }">
                {{ ran.has(selected.id) ? 'Ran' : 'Not run' }}
              </span>
            </div>
          </template>
          <p v-for="error in store.errors" :key="error" class="dt-note danger" role="alert">
            {{ error }}
          </p>
        </section>

        <section class="clauses" aria-labelledby="clauses-title">
          <h2 id="clauses-title" class="dt-head">Clauses and their scenarios</h2>
          <ol v-if="clauseRows" class="clause-list">
            <li v-for="row in clauseRows" :key="row.key" class="clause">
              <div class="clause-text">
                <code v-if="row.clause.id" class="clause-id">{{ row.clause.id }}</code>
                <p class="clause-oracle">{{ row.clause.oracleText }}</p>
                <p v-if="row.clause.implementation.length > 0" class="clause-meta">
                  Implementation: {{ row.clause.implementation.join('; ') }}
                </p>
                <p class="clause-meta">
                  {{
                    row.clause.engineTestIds.length === 0
                      ? 'No engine test named in the manifest.'
                      : `${row.clause.engineTestIds.length} engine ${row.clause.engineTestIds.length === 1 ? 'test' : 'tests'} named in the manifest.`
                  }}
                </p>
              </div>
              <ul class="clause-scenarios">
                <li v-if="row.scenarios.length === 0" class="gap">
                  Gap: no lab scenario for this clause.
                </li>
                <li v-for="entry in row.scenarios" :key="entry.id">
                  <button
                    type="button"
                    class="clause-scenario"
                    :aria-pressed="entry.id === selectedScenarioId"
                    @click="selectedScenarioId = entry.id"
                  >
                    <span class="chip" :class="{ ran: ran.has(entry.id) }">
                      {{ ran.has(entry.id) ? 'Ran' : 'Not run' }}
                    </span>
                    <span v-if="isViewerScenario(entry.id)" class="chip mark">Viewer evidence</span>
                    <span class="clause-scenario-title">{{ entry.title }}</span>
                  </button>
                </li>
              </ul>
            </li>
            <li v-if="unmapped.length > 0" class="clause">
              <div class="clause-text">
                <p class="clause-oracle">Scenarios no manifest clause names</p>
              </div>
              <ul class="clause-scenarios">
                <li v-for="entry in unmapped" :key="entry.id">
                  <button
                    type="button"
                    class="clause-scenario"
                    :aria-pressed="entry.id === selectedScenarioId"
                    @click="selectedScenarioId = entry.id"
                  >
                    <span class="chip" :class="{ ran: ran.has(entry.id) }">
                      {{ ran.has(entry.id) ? 'Ran' : 'Not run' }}
                    </span>
                    <span v-if="isViewerScenario(entry.id)" class="chip mark">Viewer evidence</span>
                    <span class="clause-scenario-title">{{ entry.title }}</span>
                  </button>
                </li>
              </ul>
            </li>
          </ol>
          <template v-else>
            <p class="clause-meta" role="status">
              The verification manifest does not pin this Oracle text, so the full clause list is
              not known. Showing the clause IDs the scenarios name.
            </p>
            <ol class="clause-list">
              <li v-for="clause in card.clauses" :key="clause.id" class="clause">
                <code class="clause-id">{{ clause.id }}</code>
                <ul class="clause-scenarios">
                  <li v-for="entry in clause.scenarios" :key="entry.id">
                    <button
                      type="button"
                      class="clause-scenario"
                      :aria-pressed="entry.id === selectedScenarioId"
                      @click="selectedScenarioId = entry.id"
                    >
                      <span class="chip" :class="{ ran: ran.has(entry.id) }">
                        {{ ran.has(entry.id) ? 'Ran' : 'Not run' }}
                      </span>
                      <span v-if="isViewerScenario(entry.id)" class="chip mark">
                        Viewer evidence
                      </span>
                      <span class="clause-scenario-title">{{ entry.title }}</span>
                    </button>
                  </li>
                </ul>
              </li>
            </ol>
          </template>
        </section>
      </div>

      <!-- Evidence -->
      <aside class="evidence" aria-labelledby="evidence-title">
        <h2 id="evidence-title" class="evidence-title">Evidence</h2>
        <p class="evidence-note">
          From the verification manifest and the audit ledger, matched by Oracle hash. What neither
          records reads “Not recorded”, never complete.
        </p>
        <ol class="evidence-list">
          <li
            v-for="item in evidence"
            :key="item.label"
            :class="{ recorded: item.recorded, info: item.info }"
          >
            <span v-if="!item.info" class="box" aria-hidden="true">{{
              item.recorded ? '✓' : ''
            }}</span>
            <span v-else class="box-gap" aria-hidden="true"></span>
            <span class="evidence-text">
              <span>{{ item.label }}</span>
              <span class="evidence-state">{{ item.state }}</span>
              <span v-if="item.detail" class="evidence-state">{{ item.detail }}</span>
            </span>
          </li>
        </ol>
      </aside>
    </div>

    <p v-else-if="scenarios.length === 0" class="dt-note" role="status">Loading the catalog…</p>

    <PageFoot place="III. Workshop · a. Card lab" />
  </section>
</template>

<style scoped>
.lab {
  width: min(1440px, 100%);
  margin: 0 auto;
  padding: 1.75rem 3rem 3rem;
  display: grid;
  gap: 1.5rem;
  color: var(--ink);
  font-family: var(--font-body);
}
h2,
h3,
p,
dl,
dd,
ol,
ul {
  margin: 0;
}
ol,
ul {
  padding: 0;
  list-style: none;
}
button {
  font: inherit;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
.lab-head {
  display: grid;
  gap: 0.9rem;
  max-width: 56rem;
}
.intro {
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--ink-soft);
}
.muted {
  color: var(--muted);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.cols {
  display: grid;
  grid-template-columns: minmax(14rem, 19rem) minmax(0, 1fr) minmax(14rem, 20rem);
  border: 1px solid var(--ink);
  align-items: stretch;
}

/* Find a card */
.finder {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
  padding: 1.5rem 1.25rem;
  border-right: 1px solid var(--ink);
  background: var(--paper-2);
}
.card-list {
  border-top: 1px solid var(--ink);
  max-height: 34rem;
  overflow-y: auto;
}
.card-list li {
  border-bottom: 1px solid var(--rule);
}
.card-row {
  width: 100%;
  min-height: 44px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 0.45rem 0.4rem;
  border: 0;
  background: transparent;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}
.card-row[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
.card-row-name {
  min-width: 0;
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.tag {
  flex: 0 0 auto;
  padding: 0.15rem 0.35rem;
  border: 1px dashed currentColor;
  font-family: var(--font-ui);
  font-size: 0.6rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--muted);
}
.tag.ran {
  border-style: solid;
  color: inherit;
}
.card-row[aria-pressed='true'] .tag {
  color: var(--paper);
}
.finder-note {
  font-size: 0.72rem;
  line-height: 1.6;
  color: var(--muted);
}

/* The chosen card */
.centre {
  display: grid;
  gap: 1.75rem;
  align-content: start;
  min-width: 0;
  padding: 1.75rem 2rem;
}
.card-top {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
  align-items: flex-start;
}
.frame {
  flex: 0 0 13rem;
  aspect-ratio: 5 / 7;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.85rem;
  border: 1px solid var(--ink);
  background: var(--paper);
}
.frame-name {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  overflow-wrap: anywhere;
}
.frame-art {
  position: relative;
  flex: 1;
  background: var(--paper-2);
  border: 1px solid var(--rule);
}
.corner {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 0 solid var(--ink);
}
.corner.tl {
  left: 6px;
  top: 6px;
  border-left-width: 1px;
  border-top-width: 1px;
}
.corner.br {
  right: 6px;
  bottom: 6px;
  border-right-width: 1px;
  border-bottom-width: 1px;
}
.frame-pin {
  font-size: 0.65rem;
  color: var(--muted);
  border-top: 1px solid var(--ink);
  padding-top: 0.35rem;
  overflow-wrap: anywhere;
}
.card-facts {
  flex: 1 1 20rem;
  min-width: 0;
  display: grid;
  gap: 1rem;
}
.name-block {
  display: grid;
  gap: 0.6rem;
  width: fit-content;
  max-width: 100%;
}
.card-title {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(2rem, 3.4vw, 3.2rem);
  line-height: 0.98;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  overflow-wrap: anywhere;
}
.facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.4rem 1.25rem;
  font-size: 0.8rem;
}
.facts dt {
  font-family: var(--font-ui);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.facts .sha {
  overflow-wrap: anywhere;
}
.run-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.25rem;
}
/* A fixed width, so "Run next scenario" and "Starting…" never move what follows it. */
.run-all {
  width: 13.5rem;
  min-height: 44px;
}
.run-all:disabled {
  opacity: 0.6;
  cursor: default;
}
/* The note's slot is reserved, so a changing note never shifts the page. */
.run-note {
  display: inline-block;
  min-width: 11rem;
  min-height: 2.6em;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--muted);
}
.link {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 0.25em;
  cursor: pointer;
}

/* The selected scenario */
.scenario {
  display: grid;
  gap: 0.9rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--ink);
}
.picker {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: end;
  gap: 0.8rem;
}
.picker select {
  min-width: 0;
  text-overflow: ellipsis;
}
.picker label span {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.scenario-title {
  font-family: var(--font-ui);
  font-weight: 400;
  font-size: 1.1rem;
  line-height: 1.35;
}
.steps {
  list-style: decimal;
  padding-left: 1.4rem;
  font-size: 0.9rem;
  line-height: 1.6;
}
.expected {
  padding: 0.7rem 0.9rem;
  border-left: 3px solid var(--warm);
  background: var(--paper-2);
  font-size: 0.85rem;
  line-height: 1.5;
}

/* Result chips: "Ran" is outlined, "Not run" dashed and muted. The server reports no pass or fail. */
.chip {
  flex: 0 0 4.2rem;
  box-sizing: border-box;
  padding: 0.1rem 0.35rem;
  border: 1px dashed var(--rule);
  color: var(--muted);
  font-family: var(--font-ui);
  font-size: 0.6rem;
  letter-spacing: 0.08em;
  text-align: center;
  text-transform: uppercase;
  white-space: nowrap;
}
.chip.ran {
  border: 1px solid var(--ink);
  color: var(--ink);
}

/* Clauses */
.clauses {
  display: grid;
  gap: 0.5rem;
}
.clause {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
  gap: 1.5rem;
  padding: 0.7rem 0;
  border-bottom: 1px solid var(--rule);
}
.clause-id {
  font-family: var(--font-body);
  font-size: 0.8rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.clause-text {
  display: grid;
  gap: 0.3rem;
  align-content: start;
  min-width: 0;
}
.clause-oracle {
  font-size: 0.85rem;
  line-height: 1.55;
}
.clause-meta {
  font-size: 0.7rem;
  line-height: 1.5;
  color: var(--muted);
}
.clause-scenarios {
  display: grid;
  gap: 0.15rem;
  align-content: start;
}
.gap {
  padding: 0.3rem 0.4rem;
  border: 1px dashed var(--rule);
  font-size: 0.75rem;
  color: var(--muted);
}
.chip.mark {
  border-style: solid;
}

.clause-scenario {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.2rem 0.3rem;
  border: 0;
  background: transparent;
  color: var(--ink);
  text-align: left;
  font-size: 0.8rem;
  cursor: pointer;
}
.clause-scenario[aria-pressed='true'] {
  background: var(--paper-2);
  box-shadow: inset 2px 0 0 var(--warm);
}
.clause-scenario-title {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Evidence */
.evidence {
  display: grid;
  gap: 0.9rem;
  align-content: start;
  min-width: 0;
  padding: 1.75rem 1.5rem;
  border-left: 1px solid var(--ink);
}
.evidence-title {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 2.1rem;
  line-height: 1;
  letter-spacing: -0.03em;
  text-transform: uppercase;
}
.evidence-note {
  font-size: 0.72rem;
  line-height: 1.7;
  color: var(--muted);
}
.evidence-list {
  border-top: 1px solid var(--ink);
}
.evidence-list li {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--rule);
}
.box {
  flex: 0 0 1.1rem;
  height: 1.1rem;
  margin-top: 0.1rem;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--rule);
  font-size: 0.7rem;
  line-height: 1;
}
.box-gap {
  flex: 0 0 auto;
  width: 1.1rem;
}
.recorded .box {
  border: 1px solid var(--ink);
  background: var(--ink);
  color: var(--paper);
}
.evidence-text {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
  font-size: 0.8rem;
}
.evidence-state {
  font-size: 0.68rem;
  line-height: 1.5;
  color: var(--muted);
}

@media (max-width: 1100px) {
  .lab {
    padding: 1.5rem 1.5rem 2.5rem;
  }
  .cols {
    grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr);
  }
  .evidence {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: 1px solid var(--ink);
  }
}
@media (max-width: 760px) {
  .lab {
    padding: 1.25rem 1rem 2rem;
  }
  .cols {
    grid-template-columns: minmax(0, 1fr);
  }
  .finder {
    border-right: 0;
    border-bottom: 1px solid var(--ink);
  }
  .card-list {
    max-height: 16rem;
  }
  .centre {
    padding: 1.25rem 1rem;
  }
  .frame {
    flex-basis: 11rem;
  }
  .clause {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.4rem;
  }
  .picker {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (prefers-reduced-motion: no-preference) {
  .card-row {
    transition:
      background-color 0.3s var(--ease),
      color 0.3s var(--ease);
  }
  .card-row:hover:not([aria-pressed='true']) {
    background: var(--paper);
  }
}
</style>
