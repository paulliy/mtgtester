<script setup lang="ts">
import PageTitle from '../components/shell/PageTitle.vue';
import PageFoot from '../components/shell/PageFoot.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DebugFlags, GameListItem } from '@mtg/shared';
import { useRoute, useRouter } from 'vue-router';
import { useGameStore } from '../stores/game';
import {
  buildLabel,
  callLines,
  compactTokens,
  gameOptionLabel,
  latencyLabel,
  logLines,
  prettyJson,
  roundLabel,
  roundsWithData,
  tokenShare,
  type DebugPayload,
} from '../lib/debugModel';

const PLACE = 'III. Workshop · c. Debug';
const PAGE = 200;

const game = useGameStore();
const route = useRoute();
const router = useRouter();

const games = ref<GameListItem[]>([]);
const gamesError = ref<string | null>(null);
const gamesLoaded = ref(false);
const data = ref<DebugPayload | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const round = ref<number | null>(null);
const selectedSequence = ref<number | null>(null);
const shown = ref(PAGE);
const exporting = ref(false);

/** The live game first (marked), then the recorded games, newest first. */
interface Option {
  id: string;
  label: string;
  item: GameListItem | null;
}
const options = computed<Option[]>(() => {
  const live = game.gameId;
  const result: Option[] = [];
  if (live !== null) {
    const item = games.value.find((entry) => entry.gameId === live) ?? null;
    result.push({
      id: live,
      label: item === null ? `live · ${live}` : gameOptionLabel(item, true),
      item,
    });
  }
  for (const item of games.value)
    if (item.gameId !== live)
      result.push({ id: item.gameId, label: gameOptionLabel(item, false), item });
  const queried = route.query['gameId'];
  if (
    typeof queried === 'string' &&
    queried !== '' &&
    !result.some((entry) => entry.id === queried)
  )
    result.push({ id: queried, label: queried, item: null });
  return result;
});

/** A `?gameId=` link wins; otherwise the live game; otherwise the newest recorded game. */
const activeGameId = computed<string | null>(() => {
  const queried = route.query['gameId'];
  if (typeof queried === 'string' && queried !== '') return queried;
  return game.gameId ?? games.value[0]?.gameId ?? null;
});
const activeItem = computed(
  () => options.value.find((entry) => entry.id === activeGameId.value)?.item ?? null,
);
const isLive = computed(() => activeGameId.value !== null && activeGameId.value === game.gameId);
const seatCount = computed(() => Math.max(activeItem.value?.seats.length ?? 0, 4));

const flags = computed(() => game.debugFlags);
const FLAG_LABELS: Record<keyof DebugFlags, string> = {
  showAIRequests: 'AI requests',
  showAIResponses: 'AI responses',
  showLegalActions: 'Legal actions',
  showSBAChecks: 'State checks',
  showPriorityPasses: 'Priority passes',
  showTokenUsage: 'Token usage',
  verboseEngine: 'Verbose engine',
};
function toggle(key: keyof DebugFlags, event: Event): void {
  game.setDebugFlags({ ...flags.value, [key]: (event.target as HTMLInputElement).checked });
}

async function message(response: Response, fallback: string): Promise<string> {
  try {
    return ((await response.json()) as { message?: string }).message ?? fallback;
  } catch {
    return fallback;
  }
}

async function loadGames(): Promise<void> {
  try {
    const response = await fetch('/api/games?limit=30');
    if (!response.ok) throw new Error(await message(response, 'Could not list games.'));
    games.value = ((await response.json()) as { games: GameListItem[] }).games;
    gamesError.value = null;
  } catch (reason) {
    gamesError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    gamesLoaded.value = true;
  }
}

async function load(): Promise<void> {
  const id = activeGameId.value;
  if (id === null) {
    data.value = null;
    return;
  }
  loading.value = true;
  try {
    const response = await fetch(`/api/games/${encodeURIComponent(id)}/debug`);
    if (!response.ok) throw new Error(await message(response, 'Could not load debug data.'));
    const body = (await response.json()) as DebugPayload;
    if (id === activeGameId.value) {
      data.value = body;
      error.value = null;
    }
  } catch (reason) {
    if (id === activeGameId.value) {
      data.value = null;
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  await Promise.all([loadGames(), load()]);
}

function pickGame(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  void router.replace({ query: { ...route.query, gameId: id } });
}

async function exportJson(): Promise<void> {
  const id = activeGameId.value;
  if (id === null || exporting.value) return;
  exporting.value = true;
  try {
    const response = await fetch(`/api/games/${encodeURIComponent(id)}/export`);
    if (!response.ok) throw new Error(await message(response, 'Could not export the game.'));
    const url = URL.createObjectURL(
      new Blob([await response.text()], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `debug-${id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    error.value = null;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    exporting.value = false;
  }
}

watch(
  activeGameId,
  () => {
    round.value = null;
    selectedSequence.value = null;
    shown.value = PAGE;
    data.value = null;
    void load();
  },
  { immediate: true },
);
// Without a `?gameId=` or live game, the newest recorded game opens once the list arrives.
watch(
  () => games.value[0]?.gameId,
  () => {
    if (data.value === null && error.value === null) void load();
  },
);
watch(round, () => {
  shown.value = PAGE;
});

const allLog = computed(() => (data.value ? logLines(data.value, seatCount.value) : []));
const allCalls = computed(() => (data.value ? callLines(data.value.aiCalls, seatCount.value) : []));
const rounds = computed(() => roundsWithData(allLog.value, allCalls.value));
const log = computed(() =>
  allLog.value.filter((line) => round.value === null || line.round === round.value),
);
const calls = computed(() =>
  allCalls.value.filter((call) => round.value === null || call.round === round.value),
);
const visibleLog = computed(() => log.value.slice(0, shown.value));
const mostTokens = computed(() => Math.max(0, ...allCalls.value.map((call) => call.tokens)));
const selected = computed(
  () =>
    calls.value.find((call) => call.sequence === selectedSequence.value) ?? calls.value[0] ?? null,
);

const heading = computed(() => {
  const row = data.value?.game;
  if (!row) return null;
  const seed = typeof row['seed'] === 'string' ? row['seed'] : null;
  return {
    seed,
    build: buildLabel(row['build_commit'], row['build_dirty']),
    batch:
      activeItem.value?.batchId == null
        ? null
        : `${activeItem.value.scenarioName ?? 'Batch'} · ${activeItem.value.batchId}`,
  };
});

// The typing reveal plays on first load only; picking a call or a round just swaps content.
const intro = ref(false);
const grown = ref(false);
let timers: ReturnType<typeof setTimeout>[] = [];
const motionOff = (): boolean =>
  game.reducedMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
let introSeen = false;
watch(data, (value) => {
  if (value === null || introSeen) return;
  introSeen = true;
  if (motionOff()) {
    grown.value = true;
    return;
  }
  intro.value = true;
  timers.push(setTimeout(() => (grown.value = true), 90));
  timers.push(setTimeout(() => (intro.value = false), 2000));
});
onMounted(() => void loadGames());
onBeforeUnmount(() => {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
});
const noData = computed(
  () => gamesLoaded.value && activeGameId.value === null && gamesError.value === null,
);
</script>

<template>
  <section class="debug">
    <header class="head">
      <div class="head-title">
        <PageTitle :place="PLACE" hide-kicker>Debug</PageTitle>
        <p v-if="heading" class="facts">
          <span v-if="heading.seed"
            >Seed <b>{{ heading.seed }}</b></span
          >
          <span>{{ heading.build }}</span>
          <span v-if="heading.batch">{{ heading.batch }}</span>
        </p>
        <div v-if="options.length > 0" class="picker dt-field">
          <label for="debug-game" class="label">Game</label>
          <select id="debug-game" :value="activeGameId ?? ''" @change="pickGame">
            <option v-for="option in options" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
        </div>
      </div>
      <div class="head-tools">
        <div v-if="rounds.length > 0" class="chips" role="group" aria-label="Turn">
          <span class="label">Turn</span>
          <span class="chip-row">
            <button type="button" class="chip" :aria-pressed="round === null" @click="round = null">
              All
            </button>
            <button
              v-for="item in rounds"
              :key="item"
              type="button"
              class="chip"
              :aria-pressed="round === item"
              @click="round = item"
            >
              {{ roundLabel(item) }}
            </button>
          </span>
        </div>
        <div class="btns">
          <button
            type="button"
            class="dt-btn"
            :disabled="activeGameId === null || loading"
            @click="refresh"
          >
            Refresh
          </button>
          <button
            type="button"
            class="dt-btn"
            :disabled="activeGameId === null || exporting"
            @click="exportJson"
          >
            Export JSON
          </button>
        </div>
      </div>
    </header>

    <div v-if="isLive" class="flags" role="group" aria-label="Live game diagnostics">
      <span class="label">Live diagnostics</span>
      <label v-for="(value, key) in flags" :key="key" class="flag">
        <input :checked="value" type="checkbox" @change="toggle(key as keyof DebugFlags, $event)" />
        {{ FLAG_LABELS[key] }}
      </label>
      <span v-if="game.liveDebug.length > 0" class="live"
        >Streaming {{ game.liveDebug.length }} live engine entries.</span
      >
    </div>

    <p v-if="gamesError" class="dt-note" role="alert">{{ gamesError }}</p>
    <p v-if="error" class="dt-note" role="alert">{{ error }}</p>
    <p v-if="noData" class="empty">
      No recorded games yet. Play a game or run a batch and it will be listed here.
    </p>

    <div v-if="data" class="columns">
      <section class="col col-log" aria-labelledby="log-title">
        <h2 id="log-title">Engine log</h2>
        <ol v-if="visibleLog.length > 0" class="log">
          <li
            v-for="(line, index) in visibleLog"
            :key="line.key"
            :class="{ halt: line.halt, type: intro && index < 12 }"
            :style="intro && index < 12 ? { animationDelay: `${0.25 + index * 0.09}s` } : undefined"
          >
            <span class="at">{{ roundLabel(line.round) }}</span>
            <span class="seat">{{ line.seat }}</span>
            <span class="text">{{ line.text }}</span>
          </li>
        </ol>
        <p v-else class="empty">No engine log for this selection.</p>
        <button
          v-if="log.length > visibleLog.length"
          type="button"
          class="dt-btn more"
          @click="shown += PAGE"
        >
          Show more ({{ log.length - visibleLog.length }} left)
        </button>
      </section>

      <section class="col col-ai" aria-labelledby="ai-title">
        <h2 id="ai-title">AI calls</h2>
        <ol v-if="calls.length > 0" class="calls">
          <li v-for="call in calls" :key="call.sequence">
            <button
              type="button"
              class="crow"
              :class="{ on: selected?.sequence === call.sequence }"
              :aria-pressed="selected?.sequence === call.sequence"
              @click="selectedSequence = call.sequence"
            >
              <span class="seq" :class="{ bad: call.noResponse }">#{{ call.sequence }}</span>
              <span class="seat">{{ call.seat }}</span>
              <span class="what">{{ call.decision }}</span>
              <span class="tok">
                <span v-if="!call.noResponse" class="track" aria-hidden="true"
                  ><span
                    class="bar"
                    :style="{
                      width: grown ? `${tokenShare(call.tokens, mostTokens) * 100}%` : '0%',
                    }"
                /></span>
                {{ call.noResponse ? 'no response' : compactTokens(call.tokens) }}
              </span>
              <span class="ms">{{ latencyLabel(call.latencyMs) }}</span>
            </button>
          </li>
        </ol>
        <p v-else class="empty">No AI calls in this game.</p>

        <div v-if="selected" class="panes">
          <div class="pane">
            <h3>Request · call #{{ selected.sequence }}</h3>
            <pre :class="{ type: intro }">{{ prettyJson(selected.row.request_json) }}</pre>
          </div>
          <div class="pane">
            <h3>Response</h3>
            <pre :class="{ type: intro, second: true }">{{
              selected.noResponse && !selected.row.response_json
                ? '[No response]'
                : prettyJson(selected.row.response_json)
            }}</pre>
          </div>
        </div>
      </section>
    </div>
    <PageFoot :place="PLACE" />
  </section>
</template>

<style scoped>
.debug {
  font-family: var(--font-body);
  max-width: 1300px;
  margin: 0 auto;
  padding: 1.5rem 1rem 2rem;
  display: grid;
  gap: 1.25rem;
  min-width: 0;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem 2rem;
}
.head-title {
  display: grid;
  gap: 0.6rem;
  min-width: 0;
}
.facts {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 1.25rem;
  font-size: 0.78rem;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.facts b {
  font-weight: 400;
  color: var(--ink);
}
.head-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.25rem;
}
.label {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.chips {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}
.chip-row {
  display: flex;
  flex-wrap: wrap;
  padding-left: 1px;
}
.chip {
  min-width: 44px;
  min-height: 44px;
  margin-left: -1px;
  padding: 0 0.5rem;
  border: 1px solid var(--ink);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition:
    background-color 0.3s var(--ease),
    color 0.3s var(--ease);
}
.chip[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
.chip:focus-visible,
.crow:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
.btns {
  display: flex;
  gap: 0.5rem 1rem;
  flex-wrap: wrap;
}
.btns .dt-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.picker {
  max-width: 48rem;
  margin-top: 0.9rem;
  display: grid;
  gap: 0.3rem;
}
.picker select {
  font-size: 0.85rem;
}
.flags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.2rem 1.1rem;
  font-size: 0.78rem;
}
.flag {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 44px;
  cursor: pointer;
}
.flag input {
  width: 1rem;
  height: 1rem;
  accent-color: var(--ink);
}
.live {
  color: var(--ok);
}
.empty {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}
.columns {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
  align-items: flex-start;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}
.col-log {
  flex: 1 1 24rem;
}
.col-ai {
  flex: 1.3 1 30rem;
}
.col h2 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 400;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--ink);
  padding-bottom: 0.4rem;
}
ol {
  margin: 0;
  padding: 0;
  list-style: none;
}
.log li {
  display: grid;
  grid-template-columns: 3rem 1.6rem minmax(0, 1fr);
  gap: 0.6rem;
  min-height: 38px;
  align-items: center;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--rule);
  font-size: 0.78rem;
  line-height: 1.55;
}
.log li.halt {
  box-shadow: inset 2px 0 0 var(--warm);
  border-bottom-color: var(--ink);
}
.at {
  color: var(--muted);
}
.seat {
  font-family: var(--font-display);
  font-size: 1rem;
}
.text {
  overflow-wrap: anywhere;
}
.more {
  align-self: flex-start;
  margin-top: 0.5rem;
}
.calls li {
  border-bottom: 1px solid var(--ink);
}
.crow {
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  display: grid;
  grid-template-columns: 3rem 1.6rem minmax(0, 1fr) 8.5rem 4rem;
  gap: 0.6rem;
  align-items: center;
  padding: 0.35rem 0.5rem;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 0.78rem;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.3s var(--ease);
}
.crow:hover,
.crow.on {
  background: var(--paper-2);
}
.crow.on {
  box-shadow: inset 2px 0 0 var(--ink);
}
.crow.on .what {
  text-decoration: underline;
  text-underline-offset: 0.3em;
}
.seq {
  color: var(--muted);
}
.seq.bad {
  color: var(--danger);
}
.what {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tok {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.4rem;
  color: var(--muted);
}
.track {
  display: block;
  position: relative;
  width: 2.4rem;
  height: 4px;
  background: var(--rule);
}
.bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--ink);
  transition: width 1s var(--ease);
}
.ms {
  text-align: right;
  color: var(--muted);
}
.panes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 1rem;
  margin-top: 0.75rem;
}
.pane {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
}
.pane h3 {
  margin: 0;
  font-family: var(--font-ui);
  font-weight: 400;
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
pre {
  margin: 0;
  padding: 0.8rem;
  background: var(--paper-2);
  border: 1px solid var(--ink);
  font-family: var(--font-body);
  font-size: 0.72rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 16rem;
  overflow: auto;
}
.type {
  animation: debugType 0.9s steps(30, end) 0.1s both;
}
pre.second {
  animation-delay: 0.5s;
}
@keyframes debugType {
  from {
    clip-path: inset(0 100% 0 0);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
}
@media (max-width: 760px) {
  .crow {
    grid-template-columns: 3rem 1.6rem minmax(0, 1fr) auto;
    row-gap: 0.1rem;
  }
  .crow .what {
    grid-column: 3 / -1;
    white-space: normal;
    overflow: visible;
  }
  .crow .tok {
    grid-column: 3;
    justify-content: flex-start;
  }
  .crow .ms {
    grid-column: 4;
  }
  .columns {
    gap: 1.5rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .type,
  pre.second {
    animation: none;
  }
  .bar,
  .crow,
  .chip {
    transition: none;
  }
}
</style>
