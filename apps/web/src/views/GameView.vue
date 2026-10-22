<script setup lang="ts">
/**
 * The board view (brief §10.2): all four battlefields, life totals, hand/library counts,
 * command zones with tax, the commander damage grid, the stack, the action log, and the
 * timeline scrubber.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { LOOKAHEAD_TURNS } from '@mtg/shared';
import type { SpectatorCard, SpectatorPermanent } from '@mtg/shared';
import ActionLog from '../components/ActionLog.vue';
import { CONNECTION_LABELS } from '../lib/socket';
import { turnPositionLabel } from '../lib/turnLabels';
import CommanderDamageGrid from '../components/CommanderDamageGrid.vue';
import CopyGameReportButton from '../components/CopyGameReportButton.vue';
import GameOverPanel from '../components/GameOverPanel.vue';
import HeldDecision from '../components/HeldDecision.vue';
import PlaybackControls from '../components/PlaybackControls.vue';
import PlayerGameView from './PlayerGameView.vue';
import SeatPanel from '../components/SeatPanel.vue';
import StackPanel from '../components/StackPanel.vue';
import { useGameStore } from '../stores/game';

const store = useGameStore();
const router = useRouter();

let bounceTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  store.connect();
  // Setup navigates here right after sending `startGame`, which round-trips over the socket
  // before `store.gameId` is set — checking immediately races that reply. Give it a moment
  // before concluding there's genuinely no game to watch (e.g. a bookmarked /game with nothing
  // started).
  if (store.gameId === null) {
    bounceTimer = setTimeout(() => {
      if (store.gameId === null) void router.replace('/');
    }, 1500);
  }
});

onUnmounted(() => {
  if (bounceTimer !== null) clearTimeout(bounceTimer);
});

const state = computed(() => store.state);

function permanentsFor(seat: string): SpectatorPermanent[] {
  return state.value?.battlefield.filter((p) => p.controller === seat) ?? [];
}

/**
 * Exile is a single shared zone in the state, but a seat panel showing "exile 7" means *this
 * player's* seven cards. Passing the whole zone to all four panels made every seat report the
 * table's total and list the same cards.
 */
function exileFor(seat: string): SpectatorCard[] {
  return state.value?.exile.filter((card) => card.owner === seat) ?? [];
}

/** Object id -> name, table-wide — lets a chip name the actual attacker/blocker it's tied to. */
const permanentNameById = computed(() => {
  const map = new Map<string, string>();
  for (const p of state.value?.battlefield ?? []) map.set(p.id, p.name);
  return map;
});

function abandon(): void {
  store.abandonGame();
  void router.push('/');
}

function resetLab(): void {
  const scenario = store.cardTestScenario;
  if (scenario !== null) store.startCardTestScenario(scenario.id);
}

const phaseLabel = computed(() => {
  const s = state.value;
  if (s === null) return '';
  return turnPositionLabel(s.phase, s.step);
});

/**
 * Shown while the runner is parked at the compute-ahead cap (brief §10.1) *and* only the user
 * can un-park it. In live mode the cap is reached constantly and by design — the presentation
 * clock is already walking forward — so telling the user to step forward there would be a
 * permanent, meaningless warning. The cap itself lives on the server; `LOOKAHEAD_TURNS` is
 * shared so this cannot quietly disagree with it.
 */
const waitingForView = computed(
  () =>
    store.isRunning &&
    store.playbackMode === 'manual' &&
    store.frontierTurn - store.viewTurn >= LOOKAHEAD_TURNS,
);
/**
 * The game-over screen (final standings/stats, plus AI self-review when there is any — ADR 0022
 * §7). Opens itself the moment a game ends, for every provider, and can be reopened from the
 * header afterwards — it covers the final board, and the board is worth looking at too.
 */
const resultsOpen = ref(false);

watch(
  () => store.gameOver !== null,
  (over) => {
    if (!over) return;
    resultsOpen.value = true;
    // The live `gameReflections` stream is the normal path; this covers a game whose reviews were
    // already written before this client had the socket (a reload on the results screen).
    void store.loadReflections();
  },
);

/**
 * Commander damage and the action log sit behind a "Game info" toggle, and the playback bar
 * behind "Playback", so by default the four seats get the whole window. Both choices are
 * remembered per browser; both start closed.
 */
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Storage blocked: the toggle still works for this visit.
  }
}
const infoOpen = ref(readFlag('mtg.gameInfoOpen'));
function toggleInfo(): void {
  infoOpen.value = !infoOpen.value;
  writeFlag('mtg.gameInfoOpen', infoOpen.value);
}
const playbackOpen = ref(readFlag('mtg.playbackOpen'));
function togglePlayback(): void {
  playbackOpen.value = !playbackOpen.value;
  writeFlag('mtg.playbackOpen', playbackOpen.value);
}

const roundLabel = computed(() => {
  const s = state.value;
  if (!s) return '';
  const numSeats = s.seats.length > 0 ? s.seats.length : 4;
  const round = Math.floor((s.turnNumber - 1) / numSeats) + 1;
  return `Round ${round} · Turn ${s.turnNumber} (${s.activePlayer}) · ${phaseLabel.value}`;
});
</script>

<template>
  <aside v-if="store.cardTestScenario" class="lab-banner">
    <div>
      <strong>{{ store.cardTestScenario.title }}</strong>
      <span>{{ store.cardTestScenario.expectedOutcome }}</span>
    </div>
    <button type="button" @click="resetLab">Reset scenario</button>
  </aside>
  <PlayerGameView v-if="store.gameMode === 'singlePlayer' && !store.gameOver" />
  <div v-else class="game">
    <!-- Game status lives in the app's top bar, so the board keeps the height of a second bar. -->
    <Teleport to="#top-bar-status" defer>
      <span v-if="state" class="phase-badge">{{ roundLabel }}</span>
      <span
        v-if="store.gameOver"
        class="game-over-badge"
        :title="store.gameOver.result.haltReason ?? ''"
      >
        🏆 Game Over: Winner {{ store.gameOver.result.winnerSeat ?? '(Draw)' }} ({{
          store.gameOver.result.turnCount
        }}
        turns)
      </span>
      <button
        v-if="store.gameOver && !resultsOpen"
        type="button"
        class="results-button"
        @click="resultsOpen = true"
      >
        Results
      </button>
      <span v-else-if="store.halt" class="halt-badge" :title="store.halt.reason">
        ⚠️ Halted: {{ store.halt.kind }} — {{ store.halt.reason }}
      </span>
      <span v-if="state?.priorityPlayer" class="priority-badge">
        <span class="priority-dot"><span class="dot" /><span class="ping" /></span>
        Priority: {{ state.priorityPlayer }}
      </span>
      <span v-if="store.apiCost" class="cost">
        {{ store.apiCost.calls }} calls · {{ store.apiCost.promptTokens.toLocaleString() }}+{{
          store.apiCost.responseTokens.toLocaleString()
        }}
        tok
      </span>
      <!-- Only a problem is worth the space: a healthy connection says nothing. -->
      <span v-if="store.connection !== 'open'" class="conn" :class="store.connection">{{
        CONNECTION_LABELS[store.connection]
      }}</span>
      <CopyGameReportButton v-if="store.gameMode === 'singlePlayer' && store.sessionToken" />
      <span v-if="waitingForView && !playbackOpen" class="waiting-hint"
        >Paused · open playback to step on</span
      >
      <button
        type="button"
        class="info-toggle"
        :aria-expanded="playbackOpen"
        aria-controls="playback-controls"
        @click="togglePlayback"
      >
        {{ playbackOpen ? 'Hide playback' : 'Playback' }}
      </button>
      <button
        type="button"
        class="info-toggle"
        :aria-expanded="infoOpen"
        aria-controls="game-info"
        @click="toggleInfo"
      >
        {{ infoOpen ? 'Hide game info' : 'Game info' }}
      </button>
    </Teleport>

    <HeldDecision
      v-if="store.heldDecision"
      :pending="store.heldDecision"
      @choose="store.resolveHeldDecision"
    />

    <div v-if="store.errors.length > 0" class="banner error">
      <p v-for="(error, index) in store.errors" :key="index">{{ error }}</p>
    </div>

    <main v-if="state" class="layout" :class="{ 'info-open': infoOpen }">
      <StackPanel :state="state" class="stack-strip" />
      <div class="seats">
        <SeatPanel
          v-for="seat in state.seats"
          :key="seat.seat"
          :seat="seat"
          :permanents="permanentsFor(seat.seat)"
          :is-active="seat.seat === state.activePlayer"
          :has-priority="seat.seat === state.priorityPlayer"
          :is-monarch="seat.seat === state.monarchSeat"
          :eliminated="state.eliminatedPlayers.includes(seat.seat)"
          :commander-damage="state.commanderDamage"
          :exile="exileFor(seat.seat)"
          :name-by-id="permanentNameById"
        />
      </div>

      <!-- Commander damage and the log stay mounted while hidden, so the log keeps following play
           and opening the panel shows it already scrolled to the present. -->
      <aside v-show="infoOpen" id="game-info" class="info-panel" aria-label="Game info">
        <div class="info-head">
          <h2>Game info</h2>
          <button type="button" class="info-close" aria-label="Close game info" @click="toggleInfo">
            ×
          </button>
        </div>
        <CommanderDamageGrid :state="state" />
        <ActionLog
          :lines="store.log"
          :follow="store.playbackMode === 'live' || store.atFrontier"
          :active-sequence="store.activeSequence ?? undefined"
          :annotations="store.annotations"
          :can-show-reasoning="store.providerKind === 'ai'"
          :show-reasoning="store.debugFlags.showAIResponses"
          @select-sequence="store.jumpToSequence"
          @update:show-reasoning="
            store.setDebugFlags({ ...store.debugFlags, showAIResponses: $event })
          "
        />
      </aside>
    </main>

    <p v-else class="waiting-board">Waiting for the first board state…</p>

    <PlaybackControls
      v-show="playbackOpen"
      id="playback-controls"
      class="controls-slot"
      :view-turn="store.viewTurn"
      :frontier-turn="store.frontierTurn"
      :mode="store.playbackMode"
      :pace-ms="store.paceMs"
      :waiting="waitingForView"
      :is-running="store.isRunning"
      :seat-count="state?.seats.length"
      :can-step-back-action="store.canStepAction(-1)"
      :can-step-forward-action="store.canStepAction(1)"
      @jump="store.seek"
      @back="store.stepBack"
      @forward="store.stepForward"
      @step-action="store.stepAction"
      @mode="store.setPlaybackMode"
      @pace="store.setPace"
      @abandon="abandon"
    />

    <GameOverPanel
      v-if="store.gameOver && resultsOpen"
      :seats="store.seats"
      :result="store.gameOver.result"
      :reflections="store.reflections"
      :expected-seats="store.reflectingSeats"
      :complete="store.reflectionsComplete"
      :standings="store.gameOver.standings"
      @jump="store.seek($event)"
      @close="resultsOpen = false"
    />
  </div>
</template>

<style scoped>
.lab-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.55rem 0.8rem;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 88%, #7256d8);
}
.lab-banner div {
  display: grid;
  gap: 0.2rem;
}
.lab-banner span {
  color: var(--muted);
  font-size: 0.78rem;
}
.game {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.6rem;
  /* The app shell owns the viewport; taking 100vh here left the playback controls under the
     fold by exactly the height of the nav bar. */
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
}
/* The controls are the floor of the layout and never give up their height to the board. */
.game > .controls-slot {
  flex-shrink: 0;
}
.phase-badge {
  color: var(--accent);
  font-weight: 700;
  background: rgb(96 165 250 / 0.12);
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  border: 1px solid rgb(96 165 250 / 0.25);
}
.game-over-badge {
  color: var(--ok);
  font-weight: 700;
  background: rgb(74 222 128 / 0.12);
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  border: 1px solid rgb(74 222 128 / 0.3);
  font-size: 0.8rem;
}
.results-button {
  padding: 0.2rem 0.55rem;
  border-color: rgb(96 165 250 / 0.4);
  border-radius: 4px;
  color: var(--accent);
  font-size: 0.72rem;
  font-weight: 600;
}
.results-button:hover {
  background: rgb(96 165 250 / 0.12);
}
.halt-badge {
  color: var(--danger);
  font-weight: 700;
  background: rgb(248 113 113 / 0.12);
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  border: 1px solid rgb(248 113 113 / 0.3);
  font-size: 0.8rem;
}
.priority-badge {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--warn);
  font-weight: 700;
  font-size: 0.8rem;
}
.priority-dot {
  position: relative;
  width: 8px;
  height: 8px;
}
.priority-dot .dot,
.priority-dot .ping {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--warn);
}
.priority-dot .ping {
  animation: ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite;
}
.cost {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.conn.open {
  color: var(--ok);
  font-weight: 700;
}
.conn.closed {
  color: var(--danger);
  font-weight: 700;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: 0.6rem;
  flex: 1;
  min-height: 0;
}
.layout.info-open {
  grid-template-columns: minmax(0, 1fr) 20rem;
}
.seats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 0.6rem;
  min-height: 0;
  height: 100%;
}
/* The stack as one slim row above the seats: its heading, then the objects left to right. */
.stack-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem;
  padding: 0.25rem 0.6rem;
}
.stack-strip :deep(h3) {
  margin: 0;
}
.stack-strip :deep(ol) {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 0.6rem;
}
.info-panel {
  grid-column: 2;
  grid-row: 1 / span 2;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-height: 0;
}
.info-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.info-head h2 {
  margin: 0;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.info-close {
  min-width: 32px;
  min-height: 32px;
  font-size: 1.1rem;
  line-height: 1;
}
/* The damage grid is sized by its content; the log takes the rest and scrolls. */
.info-panel > .grid-wrap {
  flex-shrink: 0;
  max-height: 30%;
  overflow-y: auto;
}
.info-toggle {
  font-size: 0.78rem;
}
.waiting-hint {
  color: var(--warn);
  font-size: 0.75rem;
}
.banner {
  border-radius: 4px;
  padding: 0.5rem 0.7rem;
  font-size: 0.82rem;
}
.banner p {
  margin: 0.2rem 0 0;
}
.banner.halt {
  border: 2px solid var(--danger);
  color: var(--danger);
}
.banner.halt .note {
  color: var(--muted);
  font-size: 0.75rem;
}
.banner.over {
  border: 2px solid var(--ok);
}
.banner.over ol {
  margin: 0.3rem 0 0;
  padding-left: 1.2rem;
}
.banner.error {
  border: 1px solid var(--danger);
  color: var(--danger);
}
.reason {
  color: var(--muted);
}
.waiting-board {
  flex: 1;
  color: var(--muted);
  font-style: italic;
}
</style>
