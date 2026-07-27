<script setup lang="ts">
/**
 * The board view (brief §10.2): all four battlefields, life totals, hand/library counts,
 * command zones with tax, the commander damage grid, the stack, the action log, and the
 * timeline scrubber.
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { LOOKAHEAD_TURNS } from '@mtg/shared';
import type { SpectatorCard, SpectatorPermanent } from '@mtg/shared';
import ActionLog from '../components/ActionLog.vue';
import CommanderDamageGrid from '../components/CommanderDamageGrid.vue';
import HeldDecision from '../components/HeldDecision.vue';
import PlaybackControls from '../components/PlaybackControls.vue';
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

function abandon(): void {
  store.abandonGame();
  void router.push('/');
}

const phaseLabel = computed(() => {
  const s = state.value;
  if (s === null) return '';
  return s.step === null ? s.phase : `${s.phase} · ${s.step}`;
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
const roundLabel = computed(() => {
  const s = state.value;
  if (!s) return '';
  const numSeats = s.seats.length > 0 ? s.seats.length : 4;
  const round = Math.floor((s.turnNumber - 1) / numSeats) + 1;
  return `Round ${round} · Turn ${s.turnNumber} (${s.activePlayer}) · ${phaseLabel.value}`;
});
</script>

<template>
  <div class="game">
    <header class="bar">
      <span class="app-title">MTG Commander Simulator</span>
      <span v-if="state" class="phase-badge">
        {{ roundLabel }}
      </span>
      <span v-if="store.gameOver" class="game-over-badge" :title="store.gameOver.result.haltReason ?? ''">
        🏆 Game Over: Winner {{ store.gameOver.result.winnerSeat ?? '(Draw)' }} ({{ store.gameOver.result.turnCount }} turns)
      </span>
      <span v-else-if="store.halt" class="halt-badge" :title="store.halt.reason">
        ⚠️ Halted: {{ store.halt.kind }} — {{ store.halt.reason }}
      </span>
      <span v-if="state?.priorityPlayer" class="priority-badge">
        Priority: {{ state.priorityPlayer }}
      </span>
      <span class="provider-tag">{{ store.providerKind }}</span>
      <span v-if="store.apiCost" class="cost">
        {{ store.apiCost.calls }} calls · {{ store.apiCost.promptTokens.toLocaleString() }}+{{
          store.apiCost.responseTokens.toLocaleString()
        }}
        tok
      </span>
      <span class="conn" :class="store.connection">{{ store.connection }}</span>
    </header>

    <HeldDecision
      v-if="store.heldDecision"
      :pending="store.heldDecision"
      @choose="store.resolveHeldDecision"
    />

    <div v-if="store.errors.length > 0" class="banner error">
      <p v-for="(error, index) in store.errors" :key="index">{{ error }}</p>
    </div>

    <main v-if="state" class="layout">
      <div class="seats">
        <SeatPanel
          v-for="seat in state.seats"
          :key="seat.seat"
          :seat="seat"
          :permanents="permanentsFor(seat.seat)"
          :is-active="seat.seat === state.activePlayer"
          :has-priority="seat.seat === state.priorityPlayer"
          :eliminated="state.eliminatedPlayers.includes(seat.seat)"
          :commander-damage="state.commanderDamage"
          :exile="exileFor(seat.seat)"
        />
      </div>

      <aside class="side">
        <StackPanel :state="state" />
        <CommanderDamageGrid :state="state" />
        <ActionLog
          :lines="store.log"
          :follow="store.playbackMode === 'live' || store.atFrontier"
          :active-sequence="store.activeSequence ?? undefined"
          @select-sequence="store.jumpToSequence"
        />
      </aside>
    </main>

    <p v-else class="waiting-board">Waiting for the first board state…</p>

    <PlaybackControls
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
  </div>
</template>

<style scoped>
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
.bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 0.8rem;
  color: var(--muted);
  background: var(--surface);
  padding: 0.4rem 0.8rem;
  border-radius: 6px;
  border: 1px solid var(--line);
}
.app-title {
  font-weight: 800;
  color: var(--text);
  letter-spacing: -0.01em;
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
  color: var(--warn);
  font-weight: 700;
  background: rgb(251 191 36 / 0.12);
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  border: 1px solid rgb(251 191 36 / 0.25);
}
.provider-tag {
  color: var(--muted);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.7rem;
  background: var(--surface-2);
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
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
  grid-template-columns: minmax(0, 1fr) 18rem;
  gap: 0.6rem;
  flex: 1;
  min-height: 0;
}
.seats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 0.6rem;
  min-height: 0;
  height: 100%;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-height: 0;
}
/* Stack and damage grid are sized by their content; the log takes the rest and scrolls. */
.side > .stack,
.side > .grid-wrap {
  flex-shrink: 0;
  max-height: 30%;
  overflow-y: auto;
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
