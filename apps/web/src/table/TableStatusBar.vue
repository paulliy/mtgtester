<script setup lang="ts">
/**
 * The table's bar above the board (plan M6 task 3): every seat's name and who is playing it
 * (a person, a bot, or the fallback bot for a person who is away), whose decision the table is
 * waiting on and for how long, your own clock and bank, and the button that takes your seat back
 * from the fallback bot. Clocks count down here from the server's last report; the server's own
 * deadline is the one that counts.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useTableStore } from '../stores/table';
import { formatClock } from './clockFormat';

const table = useTableStore();
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  ticker = setInterval(() => (now.value = Date.now()), 250);
});
onUnmounted(() => {
  if (ticker !== null) clearInterval(ticker);
});

const seats = computed(() =>
  (table.state?.seats ?? []).map((entry) => {
    const status = table.seatStatus[entry.seat];
    const fallback = status?.fallback === true;
    return {
      seat: entry.seat,
      name: entry.displayName ?? 'Bot',
      kind: entry.controller === 'human' ? (fallback ? 'fallback' : 'human') : 'bot',
      connected: status?.connected ?? entry.connected,
    };
  }),
);

/** The seat whose clock is running, if any: the one the table waits on. */
const waitingOn = computed(() => {
  void now.value;
  for (const [seat, clock] of Object.entries(table.clocks)) {
    if (!clock.running) continue;
    const ms = table.remainingMs(seat, now.value);
    return { seat, name: table.displayNames[seat] ?? seat, ms: ms ?? 0 };
  }
  return null;
});

const mine = computed(() => {
  const seat = table.mySeat;
  if (seat === null) return null;
  const clock = table.clocks[seat];
  if (clock === undefined) return null;
  return {
    remaining: table.remainingMs(seat, now.value) ?? clock.remainingMs,
    bank: clock.bankMs,
    running: clock.running,
  };
});

const myFallback = computed(() => {
  const seat = table.mySeat;
  return seat !== null && table.seatStatus[seat]?.fallback === true;
});
</script>

<template>
  <div class="table-bar" data-testid="table-bar">
    <p v-if="table.insecureLan" class="insecure" role="alert" data-testid="insecure-banner">
      This table runs without encryption on the host's network. Anyone on that network could read
      it.
    </p>
    <ul class="seats" aria-label="Seats">
      <li
        v-for="entry in seats"
        :key="entry.seat"
        :class="[
          'seat',
          entry.kind,
          { waiting: waitingOn?.seat === entry.seat, you: entry.seat === table.mySeat },
        ]"
        :data-testid="`bar-seat-${entry.seat}`"
      >
        <span class="seat-id" aria-hidden="true">{{ entry.seat }}</span>
        <span :class="['dot', { on: entry.connected || entry.kind === 'bot' }]" />
        <strong>{{ entry.name }}</strong>
        <span class="badge">{{
          entry.kind === 'human' ? 'player' : entry.kind === 'fallback' ? 'bot (away)' : 'bot'
        }}</span>
      </li>
    </ul>
    <span v-if="waitingOn" class="waiting" data-testid="waiting-on">
      <span class="pip" aria-hidden="true" />Waiting on {{ waitingOn.name }} —
      {{ formatClock(waitingOn.ms) }}
    </span>
    <span v-if="mine" :class="['mine', { running: mine.running }]" data-testid="my-clock">
      Your time {{ formatClock(mine.remaining) }} · bank {{ formatClock(mine.bank) }}
    </span>
    <button
      v-if="myFallback"
      type="button"
      class="dt-btn small take-back"
      data-testid="take-back"
      @click="table.resumeControl()"
    >
      Take back control
    </button>
    <button
      v-if="table.isHost && (table.phase === 'playing' || table.phase === 'starting')"
      type="button"
      class="dt-btn small danger"
      data-testid="abandon"
      @click="table.abandon()"
    >
      End the game
    </button>
  </div>
</template>

<style scoped>
.table-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
  padding: 0.45rem 1.25rem;
  border-bottom: 1px solid var(--ink);
  background: var(--paper-2);
  font-size: 0.8rem;
}
.insecure {
  flex-basis: 100%;
  margin: 0;
  padding: 0.45rem 0.7rem;
  border-left: 3px solid var(--warn);
  background: var(--paper);
  color: var(--warn);
}
.seats {
  display: flex;
  flex-wrap: wrap;
  list-style: none;
  padding: 0;
  margin: 0;
}
.seat {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  min-height: 34px;
  margin-left: -1px;
  padding: 0 0.7rem;
  border: 1px solid var(--rule);
  background: var(--paper);
  transition:
    background-color 0.3s var(--ease),
    border-color 0.3s var(--ease);
}
.seat:first-child {
  margin-left: 0;
}
.seat.you {
  border-color: var(--ink);
  position: relative;
}
.seat.waiting {
  position: relative;
  z-index: 1;
  border-color: var(--ink);
  box-shadow: inset 0 -3px 0 var(--warm);
}
.seat-id {
  font-family: var(--font-display);
  font-size: 1rem;
  line-height: 1;
}
.seat strong {
  font-family: var(--font-body);
  font-weight: 400;
}
.badge {
  font-family: var(--font-ui);
  font-size: 0.58rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.seat.fallback .badge {
  color: var(--warn);
}
.dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  border: 1px solid var(--ink);
}
.dot.on {
  background: var(--ok);
  border-color: var(--ok);
}
.waiting {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-family: var(--font-body);
}
.pip {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--warm);
  animation: barPulse 1s var(--ease) infinite alternate;
}
@keyframes barPulse {
  from {
    opacity: 0.35;
  }
  to {
    opacity: 1;
  }
}
.mine {
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--ink);
  font-family: var(--font-body);
}
.mine.running {
  background: var(--ink);
  color: var(--paper);
}
.take-back {
  background: var(--ink);
  color: var(--paper);
}
.table-bar > button:first-of-type {
  margin-left: auto;
}
@media (max-width: 640px) {
  .table-bar {
    padding: 0.45rem 1rem;
  }
  .seat {
    padding: 0 0.5rem;
  }
}
</style>
