<script setup lang="ts">
/**
 * One player's panel: life, commanders with tax, zone counts, hand (always visible — spectator
 * only, brief §10.2), the battlefield — and, expanded, the graveyard and exile.
 */
import { computed, ref } from 'vue';
import type { CommanderDamageEntry, SpectatorCard, SpectatorPermanent, SpectatorSeat } from '@mtg/shared';
import HandStrip from './HandStrip.vue';
import PermanentChip from './PermanentChip.vue';
import ZoneStrip from './ZoneStrip.vue';

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

const expanded = ref(false);

const lands = computed(() => props.permanents.filter((p) => p.typeLine.includes('Land')));
const nonlands = computed(() => props.permanents.filter((p) => !p.typeLine.includes('Land')));
const untappedLands = computed(() => lands.value.filter((p) => !p.tapped).length);

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

const flexStyles = computed(() => {
  const n = groupedNonlands.value.length;
  const l = groupedLands.value.length;
  if (n === 0 && l === 0) return { nonlandsFlex: 1, landsFlex: 1 };
  if (n === 0) return { nonlandsFlex: 0, landsFlex: 1 };
  if (l === 0) return { nonlandsFlex: 1, landsFlex: 0 };

  const nonlandsFlex = Math.max(0.6, Math.min(3, n / Math.max(1, l)));
  return { nonlandsFlex, landsFlex: 1 };
});
</script>

<template>
  <section
    class="seat"
    :class="{ active: isActive, priority: hasPriority, eliminated }"
    :data-seat="seat.seat"
  >
    <header @click="expanded = !expanded">
      <span class="id-badge">{{ seat.seat }}</span>
      <span class="label">{{ seat.label }}</span>
      <span v-if="hasPriority" class="priority-badge">PRIORITY</span>
      <span class="life-badge" :class="{ low: seat.life <= 10 }">{{ seat.life }} HP</span>
      <span v-if="eliminated" class="dead">DEAD</span>
      <span class="toggle">{{ expanded ? '▾' : '▸' }}</span>
    </header>

    <div class="meta">
      <span class="meta-item"><strong>lib</strong> {{ seat.librarySize }}</span>
      <span class="meta-item"><strong>gy</strong> {{ seat.graveyard.length }}</span>
      <span class="meta-item"><strong>exile</strong> {{ exileCards.length }}</span>
      <span class="meta-item"><strong>lands</strong> {{ untappedLands }}/{{ lands.length }}</span>
      <span v-if="seat.poisonCounters > 0" class="meta-item warn"><strong>poison</strong> {{ seat.poisonCounters }}</span>
      <span v-if="seat.mulligansTaken > 0" class="meta-item"><strong>mull</strong> {{ seat.mulligansTaken }}</span>
    </div>

    <!-- Conditional Commander Damage Badges (Only shown if > 0 commander damage taken) -->
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

    <ul v-if="seat.commanders.length > 0" class="commanders">
      <li v-for="cmd in seat.commanders" :key="cmd.cardId">
        <span class="cmd-icon">👑</span>
        <span class="cmd-name">{{ cmd.name }}</span>
        <span class="cmd-zone">({{ cmd.zone === 'gone' ? 'left the game' : cmd.zone }})</span>
        <span v-if="cmd.taxGeneric > 0" class="cmd-tax">tax +{{ cmd.taxGeneric }}</span>
      </li>
    </ul>

    <!-- Dynamic Side-by-side Battlefield Columns with Grouped Stacks -->
    <div class="battlefield-grid">
      <div
        class="battlefield-col nonlands-col"
        :style="{ flex: flexStyles.nonlandsFlex }"
        v-if="groupedNonlands.length > 0"
      >
        <div class="row-header">Non-lands ({{ nonlands.length }})</div>
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
      <div
        class="battlefield-col lands-col"
        :style="{ flex: flexStyles.landsFlex }"
        v-if="groupedLands.length > 0"
      >
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

    <!-- Visual Graveyard & Exile card picture thumbnails with hover preview -->
    <div v-if="expanded" class="detail">
      <ZoneStrip label="Graveyard" :cards="seat.graveyard" />
      <ZoneStrip label="Exile" :cards="exileCards" />
    </div>
  </section>
</template>

<style scoped>
.seat {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  padding: 0.5rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
  height: 100%;
  max-height: 100%;
  overflow: hidden;
  box-sizing: border-box;
}
.seat.active {
  border-color: var(--accent);
  box-shadow: 0 0 10px rgb(110 168 254 / 0.25);
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
  gap: 0.5rem;
  cursor: pointer;
  user-select: none;
  background: var(--surface-2);
  padding: 0.35rem 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--line);
}
.id-badge {
  font-weight: 800;
  font-size: 0.85rem;
  color: var(--accent);
  background: rgb(110 168 254 / 0.15);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
}
.label {
  flex: 1;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.priority-badge {
  font-size: 0.62rem;
  font-weight: 800;
  color: #101828;
  background: var(--warn);
  padding: 0.15rem 0.35rem;
  border-radius: 3px;
  letter-spacing: 0.04em;
}
.life-badge {
  font-size: 0.95rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--ok);
  background: rgb(94 201 138 / 0.12);
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  border: 1px solid rgb(94 201 138 / 0.3);
}
.life-badge.low {
  color: var(--danger);
  background: rgb(226 104 95 / 0.15);
  border-color: rgb(226 104 95 / 0.4);
}
.dead {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--danger);
  text-transform: uppercase;
}
.toggle {
  color: var(--muted);
  font-size: 0.8rem;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  font-size: 0.72rem;
  color: var(--text-muted);
  background: var(--surface-2);
  padding: 0.25rem 0.4rem;
  border-radius: 3px;
}
.meta-item strong {
  color: var(--muted);
}
.meta-item.warn {
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
  align-items: center;
  gap: 0.35rem;
  background: rgb(110 168 254 / 0.08);
  padding: 0.15rem 0.35rem;
  border-radius: 3px;
  border: 1px solid rgb(110 168 254 / 0.2);
}
.cmd-icon {
  font-size: 0.75rem;
}
.cmd-name {
  font-weight: 600;
  color: var(--text);
}
.cmd-zone,
.cmd-tax {
  color: var(--muted);
  font-size: 0.7rem;
}
.cmd-damage-container {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
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
.battlefield-grid {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0.6rem;
  overflow: hidden;
}
.battlefield-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 0.2rem;
}
.nonlands-col {
  border-right: 1px dashed var(--line);
  padding-right: 0.5rem;
}
.row-header {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin-bottom: 0.25rem;
}
.chips-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.hand-section {
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  padding-top: 0.3rem;
}
.hand-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: 0.2rem;
}
.spectator-badge {
  color: var(--danger);
  font-weight: 600;
  font-size: 0.6rem;
  background: rgb(226 104 95 / 0.12);
  padding: 0.05rem 0.3rem;
  border-radius: 2px;
}
.detail {
  border-top: 1px solid var(--line);
  padding-top: 0.4rem;
  flex-shrink: 0;
}
.empty {
  color: var(--muted);
  font-style: italic;
  font-size: 0.72rem;
  margin: 0;
}
</style>
