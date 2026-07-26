<script setup lang="ts">
/**
 * The board view (brief §10.2): all four battlefields, life totals, hand/library counts,
 * command zones with tax, the commander damage grid, the stack, the action log, and the
 * timeline scrubber.
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import type { SpectatorPermanent } from '@mtg/shared';
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

function abandon(): void {
  store.abandonGame();
  void router.push('/');
}

const phaseLabel = computed(() => {
  const s = state.value;
  if (s === null) return '';
  return s.step === null ? s.phase : `${s.phase} · ${s.step}`;
});

/** Shown while the runner is parked at the compute-ahead cap (brief §10.1). */
const waitingForView = computed(
  () => store.isRunning && store.frontierTurn - store.viewTurn >= 5,
);
</script>

<template>
  <div class="game">
    <header class="bar">
      <span class="game-id">{{ store.gameId ?? 'no game' }}</span>
      <span class="seed">seed <code>{{ store.seed }}</code></span>
      <span v-if="state" class="phase">
        turn {{ state.turnNumber }} · {{ state.activePlayer }} · {{ phaseLabel }}
      </span>
      <span v-if="state?.priorityPlayer" class="priority">
        priority {{ state.priorityPlayer }}
      </span>
      <span class="provider">{{ store.providerKind }}</span>
      <span v-if="store.apiCost" class="cost">
        {{ store.apiCost.calls }} calls · {{ store.apiCost.skippedCalls }} local ·
        {{ store.apiCost.promptTokens.toLocaleString() }}+{{
          store.apiCost.responseTokens.toLocaleString()
        }}
        tok
      </span>
      <span class="conn" :class="store.connection">{{ store.connection }}</span>
    </header>

    <div v-if="store.halt" class="banner halt">
      <strong>Compute halted — {{ store.halt.kind }}</strong>
      <p>{{ store.halt.reason }}</p>
      <p v-if="store.halt.cardName">Card: {{ store.halt.cardName }}</p>
      <p class="note">
        Nothing further is computed. This is a probable rules bug or an unmodeled card, and is
        surfaced rather than guessed past.
      </p>
    </div>

    <div v-if="store.gameOver" class="banner over">
      <strong>
        Game over — winner {{ store.gameOver.result.winnerSeat ?? '(none)' }} after
        {{ store.gameOver.result.turnCount }} turns
      </strong>
      <ol>
        <li v-for="row in [...store.gameOver.standings].sort((a, b) => a.position - b.position)" :key="row.seat">
          {{ row.position }}. {{ row.seat }}
          <span v-if="row.lossReason" class="reason">— {{ row.lossReason }}</span>
        </li>
      </ol>
    </div>

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
        />
      </div>

      <aside class="side">
        <StackPanel :state="state" />
        <CommanderDamageGrid :state="state" />
        <ActionLog :lines="store.log" :follow="store.atFrontier" />
      </aside>
    </main>

    <p v-else class="waiting-board">Waiting for the first board state…</p>

    <PlaybackControls
      :view-turn="store.viewTurn"
      :frontier-turn="store.frontierTurn"
      :mode="store.playbackMode"
      :waiting="waitingForView"
      @jump="store.jumpToTurn"
      @back="store.stepBack"
      @forward="store.stepForward"
      @mode="store.setPlaybackMode"
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
  height: 100vh;
  box-sizing: border-box;
}
.bar {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  flex-wrap: wrap;
  font-size: 0.78rem;
  color: var(--muted);
}
.game-id {
  font-weight: 700;
  color: var(--text);
}
.phase,
.priority {
  color: var(--accent);
}
.cost {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.conn.open {
  color: var(--ok);
}
.conn.closed {
  color: var(--danger);
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
  grid-auto-rows: minmax(0, 1fr);
  gap: 0.6rem;
  min-height: 0;
  overflow-y: auto;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-height: 0;
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
