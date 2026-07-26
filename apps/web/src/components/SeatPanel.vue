<script setup lang="ts">
/**
 * One player's panel: life, commanders with tax, zone counts, hand (always visible — spectator
 * only, brief §10.2), the battlefield — and, expanded, the graveyard and exile.
 */
import { computed, ref } from 'vue';
import type { SpectatorPermanent, SpectatorSeat } from '@mtg/shared';
import HandStrip from './HandStrip.vue';
import PermanentChip from './PermanentChip.vue';

const props = defineProps<{
  seat: SpectatorSeat;
  permanents: SpectatorPermanent[];
  isActive: boolean;
  hasPriority: boolean;
  eliminated: boolean;
}>();

const expanded = ref(false);

const lands = computed(() => props.permanents.filter((p) => p.typeLine.includes('Land')));
const nonlands = computed(() => props.permanents.filter((p) => !p.typeLine.includes('Land')));
const untappedLands = computed(() => lands.value.filter((p) => !p.tapped).length);
</script>

<template>
  <section
    class="seat"
    :class="{ active: isActive, priority: hasPriority, eliminated }"
    :data-seat="seat.seat"
  >
    <header @click="expanded = !expanded">
      <span class="id">{{ seat.seat }}</span>
      <span class="label">{{ seat.label }}</span>
      <span class="life" :class="{ low: seat.life <= 10 }">{{ seat.life }}</span>
      <span v-if="eliminated" class="dead">eliminated</span>
      <span class="toggle">{{ expanded ? '▾' : '▸' }}</span>
    </header>

    <div class="meta">
      <span>library {{ seat.librarySize }}</span>
      <span>gy {{ seat.graveyard.length }}</span>
      <span>lands {{ untappedLands }}/{{ lands.length }}</span>
      <span v-if="seat.poisonCounters > 0" class="warn">poison {{ seat.poisonCounters }}</span>
      <span v-if="seat.mulligansTaken > 0">mull {{ seat.mulligansTaken }}</span>
    </div>

    <ul class="commanders">
      <li v-for="cmd in seat.commanders" :key="cmd.cardId">
        <span class="cmd-name">{{ cmd.name }}</span>
        <span class="cmd-zone">{{ cmd.zone }}</span>
        <span v-if="cmd.taxGeneric > 0" class="cmd-tax">tax +{{ cmd.taxGeneric }}</span>
      </li>
    </ul>

    <div class="battlefield">
      <div class="row">
        <PermanentChip v-for="perm in nonlands" :key="perm.id" :permanent="perm" />
      </div>
      <div class="row">
        <PermanentChip v-for="perm in lands" :key="perm.id" :permanent="perm" />
      </div>
      <p v-if="permanents.length === 0" class="empty">no permanents</p>
    </div>

    <div class="hand-section">
      <h4>Hand <span class="spectator-only">spectator only</span></h4>
      <HandStrip :cards="seat.hand" />
    </div>

    <div v-if="expanded" class="detail">
      <div class="zone">
        <h4>Graveyard</h4>
        <ul>
          <li v-for="card in seat.graveyard" :key="card.id">{{ card.name }}</li>
          <li v-if="seat.graveyard.length === 0" class="empty">empty</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.seat {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  padding: 0.5rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
}
.seat.active {
  border-color: var(--accent);
}
.seat.priority {
  box-shadow: inset 3px 0 0 var(--accent);
}
.seat.eliminated {
  opacity: 0.45;
}
header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  cursor: pointer;
  user-select: none;
}
.id {
  font-weight: 700;
  font-size: 0.85rem;
}
.label {
  flex: 1;
  font-size: 0.85rem;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.life {
  font-size: 1.15rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.life.low {
  color: var(--danger);
}
.dead {
  font-size: 0.7rem;
  color: var(--danger);
  text-transform: uppercase;
}
.toggle {
  color: var(--muted);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  font-size: 0.72rem;
  color: var(--muted);
}
.meta .warn {
  color: var(--danger);
}
.commanders {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 0.75rem;
}
.commanders li {
  display: flex;
  gap: 0.4rem;
}
.cmd-name {
  font-weight: 600;
}
.cmd-zone,
.cmd-tax {
  color: var(--muted);
}
.battlefield {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.battlefield .row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.hand-section h4,
.zone h4 {
  margin: 0 0 0.2rem;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.spectator-only {
  color: var(--danger);
  letter-spacing: 0;
  text-transform: none;
  font-weight: 400;
}
.detail {
  border-top: 1px solid var(--line);
  padding-top: 0.4rem;
}
.zone ul {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 0.75rem;
  max-height: 12rem;
  overflow-y: auto;
}
.empty {
  color: var(--muted);
  font-style: italic;
  font-size: 0.75rem;
  margin: 0;
}
</style>
