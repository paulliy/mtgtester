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
    <ul class="seats">
      <li
        v-for="entry in seats"
        :key="entry.seat"
        :class="['seat', entry.kind, { waiting: waitingOn?.seat === entry.seat }]"
        :data-testid="`bar-seat-${entry.seat}`"
      >
        <span :class="['dot', { on: entry.connected || entry.kind === 'bot' }]" />
        <strong>{{ entry.name }}</strong>
        <span class="badge">{{
          entry.kind === 'human' ? 'player' : entry.kind === 'fallback' ? 'bot (away)' : 'bot'
        }}</span>
      </li>
    </ul>
    <span v-if="waitingOn" class="waiting" data-testid="waiting-on">
      Waiting on {{ waitingOn.name }} — {{ formatClock(waitingOn.ms) }}
    </span>
    <span v-if="mine" class="mine" data-testid="my-clock">
      Your time {{ formatClock(mine.remaining) }} · bank {{ formatClock(mine.bank) }}
    </span>
    <button v-if="myFallback" type="button" data-testid="take-back" @click="table.resumeControl()">
      Take back control
    </button>
    <button
      v-if="table.isHost && table.phase === 'playing'"
      type="button"
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
  gap: 0.75rem;
  align-items: center;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--border, #444);
}
.insecure {
  flex-basis: 100%;
  margin: 0;
  padding: 0.3rem 0.5rem;
  background: #6b3b00;
  color: #fff;
  border-radius: 4px;
}
.seats {
  display: flex;
  gap: 0.75rem;
  list-style: none;
  padding: 0;
  margin: 0;
}
.seat {
  display: flex;
  gap: 0.3rem;
  align-items: center;
}
.seat.waiting strong {
  text-decoration: underline;
}
.badge {
  font-size: 0.75rem;
  opacity: 0.75;
}
.seat.fallback .badge {
  color: #f0a040;
  opacity: 1;
}
.dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: #777;
}
.dot.on {
  background: #4caf50;
}
.waiting {
  font-weight: 600;
}
</style>
