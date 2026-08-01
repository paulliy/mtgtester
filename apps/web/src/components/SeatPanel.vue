<script setup lang="ts">
/**
 * One player's panel: life, commanders with tax, zone counts, hand (always visible — spectator
 * only, brief §10.2), the battlefield split into Board/Lands — and, expanded via the "zones"
 * toggle, the graveyard and exile.
 */
import { computed, ref } from 'vue';
import type { CommanderDamageEntry, SpectatorCard, SpectatorPermanent, SpectatorSeat } from '@mtg/shared';
import CardImage from './CardImage.vue';
import HandStrip from './HandStrip.vue';
import PermanentChip from './PermanentChip.vue';
import ZoneStrip from './ZoneStrip.vue';
import { useLifeFlash } from '../composables/useLifeFlash';

const props = defineProps<{
  seat: SpectatorSeat;
  permanents: SpectatorPermanent[];
  isActive: boolean;
  hasPriority: boolean;
  eliminated: boolean;
  commanderDamage?: CommanderDamageEntry[];
  exile?: SpectatorCard[];
  /** Object id -> permanent name, table-wide, for naming an attacker's/blocker's target. */
  nameById?: Map<string, string>;
}>();

const zonesExpanded = ref(false);
const ZONES_CAP = 6;

const lands = computed(() => props.permanents.filter((p) => p.typeLine.includes('Land')));
const nonlands = computed(() => props.permanents.filter((p) => !p.typeLine.includes('Land')));
const untappedLands = computed(() => lands.value.filter((p) => !p.tapped).length);

const lifeFlash = useLifeFlash(() => props.seat.life);

const cmdDamageTaken = computed(() => {
  if (!props.commanderDamage) return [];
  return props.commanderDamage.filter(
    (entry) => entry.victimSeat === props.seat.seat && entry.damage > 0,
  );
});

const exileCards = computed(() => props.exile ?? []);

export interface GroupedPermanent {
  permanent: SpectatorPermanent;
  count: number;
}

/**
 * Identity for stacking: two permanents collapse into one tile only when nothing a reader could
 * act on differs. P/T is in the key because a pumped copy is not the same board object as an
 * unpumped one — grouping on name alone hid that.
 */
function stackKey(p: SpectatorPermanent): string {
  const counters = Object.keys(p.counters)
    .sort()
    .map((kind) => `${kind}:${p.counters[kind] ?? 0}`)
    .join(',');
  return [
    p.name,
    p.scryfallId ?? 'null',
    p.tapped ? 'tapped' : 'untapped',
    p.summoningSick ? 'sick' : 'ready',
    p.attacking ?? 'none',
    p.blocking ?? 'none',
    p.damageMarked,
    p.power ?? '-',
    p.toughness ?? '-',
    counters,
    [...p.keywords].sort().join(','),
  ].join('|');
}

function groupPermanents(perms: SpectatorPermanent[]): GroupedPermanent[] {
  // A Map, not a linear scan that rebuilt every candidate's key on every comparison: a wide
  // board made drawing one seat quadratic in its permanent count, on every state push.
  const groups = new Map<string, GroupedPermanent>();
  for (const perm of perms) {
    const key = stackKey(perm);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { permanent: perm, count: 1 });
    else existing.count++;
  }
  return [...groups.values()];
}

const groupedNonlands = computed(() => groupPermanents(nonlands.value));
const groupedLands = computed(() => groupPermanents(lands.value));

/** Board:Lands ~58:42 (design tokens), collapsing to give an empty side's space to the other. */
const flexStyles = computed(() => {
  const n = groupedNonlands.value.length;
  const l = groupedLands.value.length;
  if (n === 0 && l === 0) return { nonlandsFlex: 1, landsFlex: 1 };
  if (n === 0) return { nonlandsFlex: 0, landsFlex: 1 };
  if (l === 0) return { nonlandsFlex: 1, landsFlex: 0 };
  return { nonlandsFlex: 1.4, landsFlex: 1 };
});
</script>

<template>
  <section
    class="seat"
    :class="{ active: isActive, priority: hasPriority, eliminated }"
    :data-seat="seat.seat"
  >
    <header>
      <span class="id-badge">{{ seat.seat }}</span>
      <span class="label">{{ seat.label }}</span>
      <span v-if="hasPriority" class="priority-dot" title="Has priority">
        <span class="dot" />
        <span class="ping" />
      </span>
      <span
        class="life-badge"
        :class="{ low: seat.life <= 10, 'flash-damage': lifeFlash === 'damage', 'flash-heal': lifeFlash === 'heal' }"
      >{{ seat.life }}</span>
      <span v-if="eliminated" class="dead">DEAD</span>
    </header>

    <div class="meta">
      <span class="meta-item"><strong>lib</strong> {{ seat.librarySize }}</span>
      <span class="meta-item"><strong>gy</strong> {{ seat.graveyard.length }}</span>
      <span class="meta-item"><strong>exile</strong> {{ exileCards.length }}</span>
      <span class="meta-item"><strong>lands</strong> {{ untappedLands }}/{{ lands.length }}</span>
      <span v-if="seat.poisonCounters > 0" class="meta-item warn"><strong>poison</strong> {{ seat.poisonCounters }}</span>
      <span v-if="seat.mulligansTaken > 0" class="meta-item"><strong>mull</strong> {{ seat.mulligansTaken }}</span>
    </div>

    <div v-if="cmdDamageTaken.length > 0" class="cmd-damage-container">
      <span
        v-for="entry in cmdDamageTaken"
        :key="entry.sourceCardId + entry.victimSeat"
        class="cmd-damage-badge"
        :title="`Taken ${entry.damage} commander damage from ${entry.sourceSeat} (${entry.sourceName})`"
      >
        ⚔ {{ entry.damage }} cmd dmg (from {{ entry.sourceSeat }} {{ entry.sourceName }})
      </span>
    </div>

    <div v-if="seat.commanders.length > 0" class="commander-row">
      <template v-for="cmd in seat.commanders" :key="cmd.cardId">
        <div class="cmdr-thumb">
          <CardImage :scryfall-id="cmd.scryfallId" :name="cmd.name" size="small" />
        </div>
        <span class="cmdr-tag">CMDR</span>
        <span class="cmdr-name">{{ cmd.name }}</span>
        <span v-if="cmd.taxGeneric > 0" class="cmdr-tax">+{{ cmd.taxGeneric }}</span>
      </template>
      <button type="button" class="zones-toggle" @click="zonesExpanded = !zonesExpanded">
        {{ zonesExpanded ? '▾ zones' : '▸ zones' }}
      </button>
    </div>

    <div class="battlefield-grid">
      <div class="battlefield-col nonlands-col" :style="{ flex: flexStyles.nonlandsFlex }">
        <div class="row-header">Board ({{ nonlands.length }})</div>
        <div class="chips-grid">
          <PermanentChip
            v-for="g in groupedNonlands"
            :key="g.permanent.id"
            :permanent="g.permanent"
            :count="g.count"
            :name-by-id="nameById"
          />
        </div>
      </div>
      <div class="battlefield-col lands-col" :style="{ flex: flexStyles.landsFlex }">
        <div class="row-header">Lands ({{ lands.length }})</div>
        <div class="chips-grid">
          <PermanentChip
            v-for="g in groupedLands"
            :key="g.permanent.id"
            :permanent="g.permanent"
            :count="g.count"
            :name-by-id="nameById"
          />
        </div>
      </div>
      <p v-if="permanents.length === 0" class="empty">no permanents on battlefield</p>
    </div>

    <div class="hand-section">
      <div class="hand-header">
        <span>HAND ({{ seat.hand.length }})</span>
        <span class="spectator-badge">SPECTATOR VIEW</span>
      </div>
      <HandStrip :cards="seat.hand" />
    </div>

    <div v-if="zonesExpanded" class="detail">
      <ZoneStrip label="Graveyard" :cards="seat.graveyard" :max="ZONES_CAP" />
      <ZoneStrip label="Exile" :cards="exileCards" :max="ZONES_CAP" />
    </div>
  </section>
</template>

<style scoped>
.seat {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: 0.44rem 0.56rem;
  display: flex;
  flex-direction: column;
  gap: 0.32rem;
  min-width: 0;
  height: 100%;
  max-height: 100%;
  overflow: hidden;
  box-sizing: border-box;
  transition: border-color 0.25s, box-shadow 0.25s;
}
.seat.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgb(96 165 250 / 0.35), 0 0 14px rgb(96 165 250 / 0.2);
}
.seat.priority {
  border-left: 3px solid var(--warn);
}
.seat.eliminated {
  opacity: 0.4;
}
header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.id-badge {
  font-weight: 800;
  font-size: 0.75rem;
  color: var(--accent);
  background: rgb(96 165 250 / 0.15);
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
}
.label {
  flex: 1;
  min-width: 0;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.priority-dot {
  position: relative;
  width: 7px;
  height: 7px;
  flex-shrink: 0;
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
.life-badge {
  font-size: 0.9rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--ok);
  background: rgb(74 222 128 / 0.12);
  border: 1px solid rgb(74 222 128 / 0.3);
  padding: 0.08rem 0.45rem;
  border-radius: 4px;
  transition: background 0.2s;
}
.life-badge.low {
  color: var(--danger);
  background: rgb(248 113 113 / 0.12);
  border-color: rgb(248 113 113 / 0.35);
}
.life-badge.flash-damage {
  animation: flash 0.8s ease-out;
}
.life-badge.flash-heal {
  animation: flashOk 0.9s ease-out;
}
.dead {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--danger);
  text-transform: uppercase;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  font-size: 0.66rem;
  color: var(--text-muted);
  flex-shrink: 0;
}
.meta-item strong {
  color: var(--muted);
}
.meta-item.warn {
  color: var(--danger);
}
.cmd-damage-container {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  flex-shrink: 0;
}
.cmd-damage-badge {
  font-size: 0.65rem;
  font-weight: 700;
  color: #ff8a80;
  background: rgb(244 67 54 / 0.15);
  border: 1px solid rgb(244 67 54 / 0.35);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
}
.commander-row {
  display: flex;
  align-items: center;
  gap: 0.32rem;
  flex-wrap: wrap;
  flex-shrink: 0;
  background: rgb(96 165 250 / 0.08);
  border: 1px solid rgb(96 165 250 / 0.2);
  border-radius: 4px;
  padding: 0.12rem 0.4rem 0.12rem 0.15rem;
}
.cmdr-thumb {
  width: 22px;
  flex-shrink: 0;
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid rgb(96 165 250 / 0.4);
}
.cmdr-tag {
  font-size: 0.58rem;
  font-weight: 800;
  color: var(--accent);
  letter-spacing: 0.03em;
}
.cmdr-name {
  font-weight: 600;
  font-size: 0.7rem;
  color: var(--text);
}
.cmdr-tax {
  color: var(--warn);
  font-size: 0.7rem;
  font-weight: 700;
}
.zones-toggle {
  margin-left: auto;
  font-size: 0.62rem;
  padding: 0.05rem 0.4rem;
  color: var(--muted);
  background: var(--surface-2);
}
.battlefield-grid {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0.35rem;
  overflow: hidden;
}
.battlefield-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
}
.nonlands-col {
  border-right: 1px dashed var(--line);
  padding-right: 0.4rem;
}
.lands-col {
  padding-left: 0.05rem;
}
.row-header {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 0.2rem;
  flex-shrink: 0;
}
.chips-grid {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 0.3rem;
}
.hand-section {
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  padding-top: 0.25rem;
}
.hand-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.62rem;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: 0.15rem;
}
.spectator-badge {
  color: var(--danger);
  font-weight: 600;
  font-size: 0.58rem;
  background: rgb(248 113 113 / 0.12);
  padding: 0.05rem 0.3rem;
  border-radius: 2px;
}
.detail {
  border-top: 1px solid var(--line);
  padding-top: 0.35rem;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.empty {
  color: var(--muted);
  font-style: italic;
  font-size: 0.72rem;
  margin: 0;
}
</style>
