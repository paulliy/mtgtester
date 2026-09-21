<script setup lang="ts">
/**
 * The 4×4 commander damage matrix (brief §10.2 — "a 4×4 matrix is the clearest presentation").
 * Rows are victims, columns are the dealing commanders. 21 is lethal (brief §5.7), so the cell
 * shades as it approaches.
 */
import { computed } from 'vue';
import type { SpectatorState } from '@mtg/shared';

const props = defineProps<{ state: SpectatorState }>();

const LETHAL = 21;

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

const damage = computed(() => {
  const map = new Map<string, number>();
  for (const entry of props.state.commanderDamage) {
    map.set(`${entry.victimSeat}|${entry.sourceCardId}`, entry.damage);
  }
  return map;
});

function cell(victim: string, cardId: string): number {
  return damage.value.get(`${victim}|${cardId}`) ?? 0;
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
              danger: cell(seat.seat, col.cardId) >= LETHAL,
              close:
                cell(seat.seat, col.cardId) >= LETHAL - 7 && cell(seat.seat, col.cardId) < LETHAL,
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
