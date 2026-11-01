<script setup lang="ts">
/**
 * The 4×4 commander damage matrix (brief §10.2 — "a 4×4 matrix is the clearest presentation").
 * Rows are victims, columns are the dealing commanders. A cell shades as it nears lethal; whether
 * it is lethal, and how far off, come from the server with each entry (CR 903.10a), so the
 * number 21 lives in the engine alone.
 */
import { computed } from 'vue';
import type { CommanderDamageEntry, SpectatorSeat, SpectatorState } from '@mtg/shared';

/** Only the seats' ids and commanders are read, so the player board's seats fit as well. */
const props = defineProps<{
  state: Pick<SpectatorState, 'commanderDamage'> & {
    seats: readonly Pick<SpectatorSeat, 'seat' | 'commanders'>[];
  };
}>();

/** A cell shows as "close" when this many points or fewer remain. Styling only. */
const CLOSE_WITHIN = 7;

interface Column {
  cardId: string;
  seat: string;
  name: string;
}

const columns = computed<Column[]>(() =>
  props.state.seats.flatMap((seat) =>
    seat.commanders.map((cmd) => ({ cardId: cmd.cardId, seat: seat.seat, name: cmd.name })),
  ),
);

const entries = computed(() => {
  const map = new Map<string, CommanderDamageEntry>();
  for (const entry of props.state.commanderDamage) {
    map.set(`${entry.victimSeat}|${entry.sourceCardId}`, entry);
  }
  return map;
});

function cell(victim: string, cardId: string): number {
  return entries.value.get(`${victim}|${cardId}`)?.damage ?? 0;
}

/** Lethal damage, as the server judged it. An entry from before the fields existed is neither. */
function isLethal(victim: string, cardId: string): boolean {
  return entries.value.get(`${victim}|${cardId}`)?.lethal === true;
}

function isClose(victim: string, cardId: string): boolean {
  const remaining = entries.value.get(`${victim}|${cardId}`)?.remaining;
  return remaining !== undefined && remaining > 0 && remaining <= CLOSE_WITHIN;
}
</script>

<template>
  <div class="grid-wrap">
    <h3>Commander damage</h3>
    <table>
      <thead>
        <tr>
          <th class="corner">dealt to ↓</th>
          <th v-for="col in columns" :key="col.cardId" :title="col.name">
            {{ col.seat }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="seat in state.seats" :key="seat.seat">
          <th class="row-head">{{ seat.seat }}</th>
          <td
            v-for="col in columns"
            :key="col.cardId"
            :class="{
              self: col.seat === seat.seat,
              danger: isLethal(seat.seat, col.cardId),
              close: isClose(seat.seat, col.cardId),
            }"
          >
            {{ col.seat === seat.seat ? '—' : cell(seat.seat, col.cardId) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.grid-wrap {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  padding: 0.4rem 0.5rem;
  overflow-x: auto;
}
h3 {
  margin: 0 0 0.3rem;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}
th,
td {
  border: 1px solid var(--line);
  padding: 0.1rem 0.2rem;
  text-align: center;
}
.corner,
.row-head {
  color: var(--muted);
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}
td.self {
  color: var(--muted);
  background: var(--surface-2);
}
td.close {
  color: var(--warn);
  font-weight: 700;
}
td.danger {
  color: var(--danger);
  font-weight: 700;
}
</style>
