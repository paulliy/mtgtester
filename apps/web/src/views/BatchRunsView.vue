<script setup lang="ts">
/**
 * Batch runs (redesign plan, phase 7; Decktank `Batches.dc.html`): the saved runs down the left,
 * the chosen run on the right. `/batch` shows the newest run, `/batch/:id` a chosen one, and
 * picking a run swaps the route in place, so the page never reloads and its numbers change where
 * they stand. A queued or running run is polled every two seconds until it ends.
 */
import PageTitle from '../components/shell/PageTitle.vue';
import PageFoot from '../components/shell/PageFoot.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import TweenNumber from '../components/stats/TweenNumber.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type { BatchListItem, BatchResults } from '@mtg/shared';
import { PROVIDER_LABELS } from '../lib/providerLabels';
import {
  FAIR_SHARE_PERCENT,
  aiDetail,
  doneText,
  formatWhen,
  fraction,
  gameRows,
  isActive,
  plural,
  runLabel,
  seatRows,
  seatTip,
  splitSegments,
  statusTag,
  type GameFilter,
} from '../lib/batchModel';

const POLL_MS = 2000;
const route = useRoute();
const router = useRouter();

const runs = ref<BatchListItem[] | null>(null);
const results = ref<BatchResults | null>(null);
const listError = ref<string | null>(null);
const detailError = ref<string | null>(null);
const filter = ref<GameFilter>('all');
const confirming = ref(false);
const cancelError = ref<string | null>(null);
/** Entrance animations play once; after the first paint this goes false and they never replay. */
const intro = ref(true);
/** Bars start empty and grow once, then follow their values. */
const grown = ref(false);
let poll: number | null = null;
let alive = true;
const timers: number[] = [];

const routeId = computed(() => {
  const raw = route.params['id'];
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === 'string' && id !== '' ? id : null;
});
/** The route's run, else the newest. */
const selectedId = computed(() => routeId.value ?? runs.value?.[0]?.batchId ?? null);
const empty = computed(
  () => runs.value !== null && runs.value.length === 0 && routeId.value === null,
);

const progress = computed(() => results.value?.progress ?? null);
const active = computed(() => progress.value !== null && isActive(progress.value.status));

function listLabel(run: BatchListItem): string {
  return runLabel(run.name, run.scenarioNames);
}
const heading = computed(() =>
  progress.value === null
    ? ''
    : runLabel(
        progress.value.name,
        progress.value.scenarios.map((scenario) => scenario.name),
      ),
);
const subline = computed(() => {
  if (progress.value === null) return '';
  const when = formatWhen(progress.value.createdAt);
  return `${when === '' ? '' : `${when} · `}batch seed ${progress.value.seed}`;
});
const statsLink = computed(() =>
  selectedId.value === null ? '/stats' : `/stats?batchId=${encodeURIComponent(selectedId.value)}`,
);

// --- Loading ---------------------------------------------------------------------------------

async function readMessage(response: Response, fallback: string): Promise<string> {
  try {
    return ((await response.json()) as { message?: string }).message ?? fallback;
  } catch {
    return fallback;
  }
}

async function loadRuns(): Promise<void> {
  try {
    const response = await fetch('/api/batches?limit=50');
    if (!response.ok) throw new Error(await readMessage(response, 'Could not load batch runs.'));
    runs.value = ((await response.json()) as { batches: BatchListItem[] }).batches;
    listError.value = null;
  } catch (reason) {
    listError.value = reason instanceof Error ? reason.message : String(reason);
    runs.value ??= [];
  }
}

async function loadResults(id: string): Promise<void> {
  try {
    const response = await fetch(`/api/batches/${encodeURIComponent(id)}/results`);
    if (!response.ok) throw new Error(await readMessage(response, 'Could not load this run.'));
    const body = (await response.json()) as BatchResults;
    // A slower answer for a run the player has since left must not replace the one on screen.
    if (id !== selectedId.value) return;
    results.value = body;
    detailError.value = null;
    // Let the first frame paint empty bars, then grow them.
    if (!grown.value) timers.push(window.setTimeout(() => (grown.value = true), 90));
    if (intro.value) timers.push(window.setTimeout(() => (intro.value = false), 2400));
  } catch (reason) {
    if (id !== selectedId.value) return;
    detailError.value = reason instanceof Error ? reason.message : String(reason);
    results.value = null;
  }
}

function stopPolling(): void {
  if (poll !== null) window.clearTimeout(poll);
  poll = null;
}
function schedule(): void {
  stopPolling();
  if (!alive || !active.value) return;
  poll = window.setTimeout(() => void tick(), POLL_MS);
}
async function tick(): Promise<void> {
  const id = selectedId.value;
  if (id === null) return;
  await Promise.all([loadResults(id), loadRuns()]);
  schedule();
}

watch(
  selectedId,
  async (id, previous) => {
    stopPolling();
    if (id === null) {
      results.value = null;
      return;
    }
    // The old run stays on screen until the new one arrives, so nothing jumps.
    if (previous !== undefined && previous !== null) filter.value = 'all';
    await loadResults(id);
    schedule();
  },
  { immediate: true },
);

onMounted(() => void loadRuns());
onBeforeUnmount(() => {
  alive = false;
  stopPolling();
  timers.forEach((timer) => window.clearTimeout(timer));
});

function pick(run: BatchListItem): void {
  if (run.batchId === routeId.value) return;
  void router.replace({ name: 'batch-results', params: { id: run.batchId } });
}

// --- Cancel ----------------------------------------------------------------------------------

async function cancelRun(): Promise<void> {
  confirming.value = false;
  const id = selectedId.value;
  if (id === null) return;
  cancelError.value = null;
  try {
    const response = await fetch(`/api/batches/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error(await readMessage(response, 'Could not cancel the run.'));
  } catch (reason) {
    cancelError.value = reason instanceof Error ? reason.message : String(reason);
  }
  await tick();
}

// --- The chosen run --------------------------------------------------------------------------

const facts = computed(() => {
  const data = results.value;
  if (data === null) return null;
  const { aggregate, progress: run } = data;
  return {
    finished: run.finishedGames,
    total: run.totalGames,
    failed: run.failedGames,
    averageTurns: aggregate.averageTurns,
    ai: aggregate.ai,
  };
});
const seats = computed(() => (results.value === null ? [] : seatRows(results.value.aggregate)));
const finishedGames = computed(() => results.value?.aggregate.gamesFinished ?? 0);
const scenarioBlocks = computed(() => {
  const data = results.value;
  if (data === null) return [];
  return data.progress.scenarios.map((scenario) => {
    const aggregate = data.scenarioAggregates.find((entry) => entry.scenarioId === scenario.id);
    const segments = aggregate === undefined ? [] : splitSegments(aggregate);
    return {
      id: scenario.id,
      name: scenario.name,
      provider: PROVIDER_LABELS[scenario.providerKind],
      games:
        scenario.completedGames < scenario.games
          ? `${scenario.completedGames} of ${plural(scenario.games, 'game')}`
          : plural(scenario.games, 'game'),
      turns:
        aggregate?.averageTurns == null ? '' : `${aggregate.averageTurns.toFixed(1)} turns avg`,
      ai:
        aggregate === undefined || aggregate.ai.calls === 0
          ? 'no AI calls'
          : `${plural(aggregate.ai.calls, 'call')} · $${aggregate.ai.costUsd.toFixed(2)}`,
      segments,
      label: `Wins by seat: ${
        segments.length === 0
          ? 'none yet'
          : segments.map((item) => `${item.letter} ${item.wins}`).join(', ')
      }`,
    };
  });
});
const rows = computed(() => (results.value === null ? [] : gameRows(results.value.games, 'all')));
const failedCount = computed(() => rows.value.filter((row) => row.failed).length);
const shownRows = computed(() =>
  filter.value === 'failed' ? rows.value.filter((row) => row.failed) : rows.value,
);
const FILTERS: Array<{ id: GameFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'failed', label: 'Failed only' },
];
const gamesNote = computed(
  () =>
    `Showing ${shownRows.value.length} of ${filter.value === 'failed' ? failedCount.value : rows.value.length}`,
);

function barWidth(value: number): string {
  return grown.value ? `${(Math.min(1, Math.max(0, value)) * 100).toFixed(1)}%` : '0%';
}
</script>

<template>
  <section class="runs-page" :class="{ intro, single: empty }">
    <div class="runs-cols">
      <!-- The runs -->
      <section class="runs" aria-label="Batch runs">
        <PageTitle place="II. Records · b. Batch runs" hide-kicker>Batch runs</PageTitle>
        <RouterLink to="/batch/new" class="dt-btn new-btn"
          >New batch <span class="dt-arr" aria-hidden="true"
        /></RouterLink>
        <p v-if="listError" class="dt-note danger" role="alert">{{ listError }}</p>
        <p v-if="runs === null" class="state">Loading…</p>
        <p v-else-if="empty" class="state">
          No batch runs yet. Set one up and its results are saved here.
        </p>
        <ol v-else class="run-list">
          <li
            v-for="(run, index) in runs"
            :key="run.batchId"
            class="rise"
            :style="{ '--i': index }"
          >
            <button
              type="button"
              class="run"
              :class="{ on: run.batchId === selectedId }"
              :aria-pressed="run.batchId === selectedId"
              @click="pick(run)"
            >
              <span class="run-top">
                <span class="run-name">{{ listLabel(run) }}</span>
                <span class="tag" :class="statusTag(run.status).tone">{{
                  statusTag(run.status).label
                }}</span>
              </span>
              <span class="run-meta"
                >{{ formatWhen(run.createdAt) }} · {{ plural(run.scenarioCount, 'scenario') }}</span
              >
              <span class="run-progress">
                <span class="track"
                  ><span
                    class="fill grow"
                    :style="{ width: barWidth(fraction(run.completedGames, run.totalGames)) }"
                  ></span
                ></span>
                <span class="done">{{ doneText(run) }}</span>
              </span>
            </button>
          </li>
        </ol>
      </section>

      <!-- The chosen run -->
      <section v-if="!empty" class="detail" aria-labelledby="run-title">
        <p v-if="detailError" class="dt-note danger" role="alert">{{ detailError }}</p>
        <p v-else-if="results === null" class="state">Loading…</p>
        <template v-else-if="progress && facts">
          <div class="d-head rise" style="--i: 0">
            <div class="d-title">
              <h2 id="run-title">{{ heading }}</h2>
              <span class="sub">{{ subline }}</span>
            </div>
            <div class="d-actions">
              <button v-if="active" type="button" class="dt-btn" @click="confirming = true">
                Cancel run
              </button>
              <RouterLink :to="statsLink" class="dt-btn"
                >Deck stats for this run <span class="dt-arr" aria-hidden="true"
              /></RouterLink>
            </div>
          </div>

          <p v-if="cancelError" class="dt-note danger" role="alert">{{ cancelError }}</p>
          <p v-if="progress.failure" class="dt-note danger">
            Stopped: {{ progress.failure.reason }}
          </p>

          <dl class="tiles rise" style="--i: 1">
            <div class="tile">
              <dt>Games</dt>
              <dd>
                <span class="big"><TweenNumber :value="facts.finished" /></span>
                <span class="unit">of {{ facts.total }} finished</span>
              </dd>
            </div>
            <div class="tile">
              <dt>Failed</dt>
              <dd>
                <span class="big"><TweenNumber :value="facts.failed" /></span>
                <span class="unit">{{ facts.failed > 0 ? 'see the list' : 'none' }}</span>
              </dd>
            </div>
            <div class="tile">
              <dt>Average game</dt>
              <dd>
                <span class="big"
                  ><TweenNumber
                    v-if="facts.averageTurns !== null"
                    :value="facts.averageTurns"
                    :decimals="1"
                  /><template v-else>—</template></span
                >
                <span class="unit">turns</span>
              </dd>
            </div>
            <div class="tile">
              <dt>AI</dt>
              <dd>
                <span class="big"
                  ><template v-if="facts.ai.calls > 0"
                    >$<TweenNumber :value="facts.ai.costUsd" :decimals="2" /></template
                  ><TweenNumber v-else :value="0" /></span
                ><span class="unit">{{ aiDetail(facts.ai) }}</span>
              </dd>
            </div>
          </dl>

          <div class="figs rise" style="--i: 2">
            <!-- By seat -->
            <section class="fig" aria-labelledby="seat-title">
              <h3 id="seat-title">
                By seat<span class="fig-no" aria-hidden="true">FIG. 001</span>
              </h3>
              <div
                v-for="row in seats"
                :key="row.letter"
                class="seat-row"
                :title="seatTip(row, finishedGames)"
              >
                <span class="seat-letter">{{ row.letter }}</span>
                <span class="track bar"
                  ><span class="fill grow" :style="{ width: barWidth(row.share) }"></span
                  ><span
                    class="fair"
                    aria-hidden="true"
                    :style="{ left: `${FAIR_SHARE_PERCENT}%` }"
                  ></span
                ></span>
                <span class="seat-wins"
                  ><TweenNumber :value="row.wins" /> {{ row.wins === 1 ? 'win' : 'wins' }}</span
                >
                <span class="seat-pos"
                  >avg
                  <TweenNumber
                    v-if="row.averagePosition !== null"
                    :value="row.averagePosition"
                    :decimals="1"
                  /><template v-else>—</template></span
                >
              </div>
              <span class="cap">¦ FAIR SHARE, 1 IN 4</span>
            </section>

            <!-- Scenarios -->
            <section class="fig" aria-labelledby="scen-title">
              <h3 id="scen-title">
                Scenarios<span class="fig-no" aria-hidden="true">FIG. 002</span>
              </h3>
              <div v-for="scenario in scenarioBlocks" :key="scenario.id" class="scenario">
                <span class="sc-top">
                  <span class="sc-name">{{ scenario.name }}</span>
                  <span class="sc-provider">{{ scenario.provider }}</span>
                </span>
                <span class="sc-stats"
                  ><span>{{ scenario.games }}</span
                  ><span v-if="scenario.turns">{{ scenario.turns }}</span
                  ><span class="muted">{{ scenario.ai }}</span></span
                >
                <span
                  class="split"
                  :class="{ none: scenario.segments.length === 0 }"
                  role="img"
                  :aria-label="scenario.label"
                >
                  <span
                    v-for="segment in scenario.segments"
                    :key="segment.letter"
                    class="seg grow"
                    :class="`tone-${segment.letter.toLowerCase()}`"
                    :title="`Seat ${segment.letter} won ${segment.wins}`"
                    :style="{ flexGrow: grown ? segment.wins : 0.001 }"
                    >{{ segment.letter }} {{ segment.wins }}</span
                  >
                </span>
              </div>
            </section>
          </div>

          <!-- Games -->
          <section class="games rise" style="--i: 3" aria-labelledby="games-title">
            <div class="games-head">
              <h3 id="games-title">Games<span class="fig-no" aria-hidden="true">FIG. 003</span></h3>
              <span class="filters">
                <button
                  v-for="item in FILTERS"
                  :key="item.id"
                  type="button"
                  :aria-pressed="filter === item.id"
                  @click="filter = item.id"
                >
                  [ {{ item.label }} ]
                </button>
              </span>
            </div>
            <div class="gt gt-head" aria-hidden="true">
              <span>Game</span><span>Scenario</span><span class="wide-only">Seed</span
              ><span>Winner</span><span>Turns</span><span class="wide-only">Finish order</span
              ><span></span>
            </div>
            <ol class="game-list">
              <li
                v-for="row in shownRows"
                :key="row.key"
                class="gt game"
                :class="{ failed: row.failed }"
              >
                <span>{{ row.index }}</span>
                <span class="cut">{{ row.scenario }}</span>
                <span class="wide-only muted cut">{{ row.seed }}</span>
                <span class="winner">{{ row.winner }}</span>
                <span>{{ row.turns }}</span>
                <span class="wide-only order cut" :class="{ muted: !row.failed }">{{
                  row.order
                }}</span>
                <RouterLink
                  class="debug-link"
                  :to="{ name: 'debug', query: { gameId: row.gameId } }"
                  :aria-label="`Open game ${row.index} in Debug`"
                  >[ Debug ]</RouterLink
                >
                <span v-if="row.failed" class="reason-sm">{{ row.order }}</span>
              </li>
            </ol>
            <p v-if="rows.length === 0" class="state">No games have started yet.</p>
            <p v-else-if="shownRows.length === 0" class="state">No failed games.</p>
            <span class="note">{{ gamesNote }}</span>
          </section>
        </template>
      </section>
    </div>

    <PageFoot place="II. Records · b. Batch runs" />
  </section>

  <ConfirmDialog
    v-if="confirming"
    title="Cancel this run?"
    message="The game in progress is abandoned and the games not yet played are skipped. Finished games stay in the results."
    confirm-label="Cancel run"
    cancel-label="Keep running"
    @cancel="confirming = false"
    @confirm="cancelRun"
  />
</template>

<style scoped>
.runs-page {
  max-width: 1440px;
  margin: 0 auto;
  padding: 1.75rem 3rem 3rem;
  font-family: var(--font-body);
  color: var(--ink);
}
.runs-cols {
  display: grid;
  grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
  gap: 2.5rem;
  align-items: start;
}
.runs-page.single .runs-cols {
  grid-template-columns: minmax(0, 1fr);
}
h2,
h3,
p,
dl,
dd,
ol {
  margin: 0;
}
ol {
  padding: 0;
  list-style: none;
}
button,
a {
  font: inherit;
}
button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
.muted {
  color: var(--muted);
}
.state {
  font-size: 0.85rem;
  color: var(--muted);
}

/* Entrances: once, on first paint. `.intro` drops away after the first seconds. */
.intro .rise {
  animation: runsRise 0.55s var(--ease) calc(var(--i, 0) * 0.07s) both;
}
@keyframes runsRise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.grow {
  transition:
    width 1s var(--ease),
    flex-grow 1s var(--ease);
}

/* The runs */
.runs {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}
.new-btn {
  align-self: flex-start;
}
.run-list {
  border-top: 1px solid var(--ink);
}
.run-list li {
  border-bottom: 1px solid var(--ink);
}
.run {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.8rem 0.6rem calc(0.8rem) calc(0.6rem - 2px);
  border: 0;
  border-left: 2px solid transparent;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.3s var(--ease);
}
.run:hover,
.run.on {
  background: var(--paper-2);
}
.run.on {
  border-left-color: var(--ink);
}
.run-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
}
.run-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.run.on .run-name {
  text-decoration: underline;
  text-underline-offset: 0.3em;
}
.tag {
  flex: 0 0 auto;
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--ink);
  font-family: var(--font-ui);
  font-size: 0.6rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink);
  background: transparent;
}
.tag.running {
  border-color: var(--warm);
  color: var(--warm);
}
.tag.failed {
  background: var(--ink);
  color: var(--paper);
}
.tag.cancelled {
  border-color: var(--rule);
  color: var(--muted);
}
.run-meta {
  font-size: 0.725rem;
  color: var(--muted);
}
.run-progress {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.725rem;
  font-variant-numeric: tabular-nums;
}
.track {
  position: relative;
  flex: 1;
  height: 6px;
  background: var(--mana-c-tint);
  box-shadow: inset 0 0 0 1px var(--rule);
}
.track.bar {
  height: 10px;
}
.fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--ink);
}
.done {
  white-space: nowrap;
}

/* The chosen run */
.detail {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
  min-width: 0;
  padding-top: 1.6rem;
}
.d-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem 2rem;
}
.d-title {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}
.d-title h2 {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 2.65rem;
  line-height: 1;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  overflow-wrap: anywhere;
}
.sub {
  font-size: 0.725rem;
  color: var(--muted);
}
.d-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  border-top: 1px solid var(--ink);
  border-left: 1px solid var(--ink);
}
.tile {
  min-width: 0;
  padding: 0.9rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  border-right: 1px solid var(--ink);
  border-bottom: 1px solid var(--ink);
}
dt {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.tile dd {
  height: 3rem;
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
}
.big {
  white-space: nowrap;
  font-family: var(--font-display);
  font-size: 2.1rem;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.unit {
  white-space: nowrap;
  font-size: 0.725rem;
  color: var(--muted);
}

.figs {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
}
.fig {
  flex: 1 1 20rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.fig h3,
.games h3 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
  font-size: 1.05rem;
  font-weight: 400;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.fig h3 {
  border-bottom: 1px solid var(--ink);
  padding-bottom: 0.4rem;
}
.fig-no {
  font-size: 0.6rem;
  letter-spacing: 0.09em;
  color: var(--muted);
}
.seat-row {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) 4.5rem 4.5rem;
  gap: 0.75rem;
  align-items: center;
}
.seat-letter {
  font-family: var(--font-display);
  font-size: 1.6rem;
  line-height: 1;
}
.seat-wins,
.seat-pos {
  font-size: 0.8rem;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.seat-pos {
  color: var(--muted);
}
.fair {
  position: absolute;
  top: -4px;
  bottom: -4px;
  border-left: 1px dashed var(--ink);
}
.cap {
  font-size: 0.6rem;
  letter-spacing: 0.09em;
  color: var(--muted);
}
.scenario {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--ink);
}
.sc-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
}
.sc-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.sc-provider {
  flex: 0 0 auto;
  font-size: 0.725rem;
  color: var(--muted);
}
.sc-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1.25rem;
  font-size: 0.8rem;
}
.split {
  box-sizing: border-box;
  display: flex;
  gap: 2px;
  height: 1.6rem;
}
.split.none {
  border: 1px solid var(--rule);
}
.seg {
  flex: 0.001 1 0;
  min-width: 1.4rem;
  overflow: hidden;
  white-space: nowrap;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
}
.tone-a {
  background: var(--ink-soft);
  color: var(--paper);
}
.tone-b {
  background: var(--muted);
  color: var(--paper);
}
.tone-c {
  background: var(--rule);
  color: var(--ink);
}
.tone-d {
  background: var(--mana-c-tint);
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--rule);
}

/* Games */
.games {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.games-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem 1rem;
  border-bottom: 1px solid var(--ink);
  padding-bottom: 0.4rem;
}
.filters {
  display: flex;
  gap: 1rem;
  font-size: 0.8rem;
}
.filters button {
  min-height: 32px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.filters button[aria-pressed='true'] {
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 0.35em;
}
.gt {
  display: grid;
  grid-template-columns: 3rem minmax(0, 1fr) 7rem 4rem 4rem minmax(0, 1.3fr) 4.5rem;
  gap: 0.75rem;
  align-items: center;
}
.gt-head {
  padding: 0 0.6rem;
  font-family: var(--font-ui);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.game-list {
  border-top: 1px solid var(--ink);
}
.game {
  padding: 0.5rem 0.6rem 0.5rem calc(0.6rem - 2px);
  border-left: 2px solid transparent;
  border-bottom: 1px solid var(--ink);
  font-size: 0.8rem;
  transition: background-color 0.3s var(--ease);
}
.game:hover {
  background: var(--paper-2);
}
.game.failed {
  border-left-color: var(--ink);
}
.cut {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.winner {
  font-family: var(--font-display);
  font-size: 1.15rem;
}
.order.muted {
  color: var(--muted);
}
.debug-link {
  justify-self: end;
  white-space: nowrap;
  color: var(--ink);
  text-decoration: none;
}
.debug-link:hover {
  text-decoration: underline;
  text-underline-offset: 0.3em;
}
.reason-sm {
  display: none;
}
:deep(.dt-footline) {
  margin-top: 3rem;
}
.note {
  font-size: 0.725rem;
  color: var(--muted);
}

@media (max-width: 1000px) {
  .runs-cols {
    grid-template-columns: minmax(0, 1fr);
    gap: 1.5rem;
  }
  .detail {
    padding-top: 0;
  }
}
@media (max-width: 760px) {
  .runs-page {
    padding: 1.25rem 1rem 2.5rem;
  }
  /* A long history must not push the selected run off the first screen: the list scrolls. */
  .run-list {
    max-height: 18rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-bottom: 1px solid var(--rule);
  }
  .d-title h2 {
    font-size: 1.9rem;
  }
  .tile {
    padding: 0.75rem 0.8rem;
  }
  .big {
    font-size: 1.8rem;
  }
  .tile dd {
    flex-direction: column;
    align-items: flex-start;
    height: 4.2rem;
    gap: 0.3rem;
  }
  .gt {
    grid-template-columns: 2.4rem minmax(0, 1fr) 3.2rem 2.8rem auto;
    gap: 0.4rem;
  }
  .wide-only {
    display: none;
  }
  .reason-sm {
    display: block;
    grid-column: 1 / -1;
    font-size: 0.725rem;
    overflow-wrap: anywhere;
  }
}
@media (prefers-reduced-motion: reduce) {
  .intro .rise {
    animation: none;
  }
  .grow,
  .run,
  .game {
    transition: none;
  }
}
</style>
