<script setup lang="ts">
/**
 * One player's panel: life, commanders with tax, zone counts, hand (always visible — spectator
 * only, brief §10.2), the battlefield split into Board/Lands — and, expanded via the "zones"
 * toggle, the graveyard and exile.
 */
import { computed, ref } from 'vue';
import type {
  CommanderDamageEntry,
  SpectatorCard,
  SpectatorPermanent,
  SpectatorSeat,
} from '@mtg/shared';
import CardImage from './CardImage.vue';
import GlobalCounters from './GlobalCounters.vue';
import HandStrip from './HandStrip.vue';
import PermanentChip from './PermanentChip.vue';
import ZoneStrip from './ZoneStrip.vue';
import { useLifeFlash } from '../composables/useLifeFlash';
import { useCardPreviewStore } from '../stores/cardPreview';
import { groupPermanents, type GroupedPermanent } from '../lib/stackPermanents';

const props = defineProps<{
  seat: SpectatorSeat;
  permanents: SpectatorPermanent[];
  isActive: boolean;
  hasPriority: boolean;
  isMonarch: boolean;
  eliminated: boolean;
  commanderDamage?: CommanderDamageEntry[];
  exile?: SpectatorCard[];
  /** Object id -> permanent name, table-wide, for naming an attacker's/blocker's target. */
  nameById?: Map<string, string>;
}>();

const zonesExpanded = ref(false);
const cardPreview = useCardPreviewStore();

/** The seat is labelled by its commander, so hovering the label shows that commander's card. */
function previewCommander(
  commander: { scryfallId: string | null; name: string },
  event: MouseEvent,
): void {
  cardPreview.show({ scryfallId: commander.scryfallId, name: commander.name });
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function moveCommanderPreview(event: MouseEvent): void {
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function hideCommanderPreview(): void {
  cardPreview.hide();
}
const commanderTax = computed(() =>
  props.seat.commanders.reduce((total, commander) => total + commander.taxGeneric, 0),
);
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

export type { GroupedPermanent };

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
      <span
        v-for="cmd in seat.commanders"
        :key="cmd.cardId"
        class="cmdr-thumb"
        @mouseenter="previewCommander(cmd, $event)"
        @mousemove="moveCommanderPreview"
        @mouseleave="hideCommanderPreview"
      >
        <CardImage :scryfall-id="cmd.scryfallId" :name="cmd.name" size="small" />
      </span>
      <span
        class="label"
        :class="{ 'has-preview': seat.commanders.length > 0 }"
        @mouseenter="seat.commanders[0] && previewCommander(seat.commanders[0], $event)"
        @mousemove="moveCommanderPreview"
        @mouseleave="hideCommanderPreview"
        >{{ seat.label }}</span
      >
      <span
        v-if="commanderTax > 0"
        class="cmdr-tax"
        :title="`Commander tax: the next cast from the command zone costs {${commanderTax}} more`"
        >+{{ commanderTax }}</span
      >
      <span
        v-if="isMonarch"
        class="monarch-badge"
        title="This player is the monarch"
        aria-label="Monarch"
        >MONARCH</span
      >
      <span v-if="hasPriority" class="priority-dot" title="Has priority">
        <span class="dot" />
        <span class="ping" />
      </span>
      <span
        class="life-badge"
        :class="{
          low: seat.life <= 10,
          'flash-damage': lifeFlash === 'damage',
          'flash-heal': lifeFlash === 'heal',
        }"
        >{{ seat.life }}</span
      >
      <span v-if="eliminated" class="dead">DEAD</span>
    </header>

    <GlobalCounters
      :energy="seat.energy"
      :poison-counters="seat.poisonCounters"
      :counters="seat.counters"
      compact
    />

    <div class="meta">
      <span class="meta-item"><strong>lib</strong> {{ seat.librarySize }}</span>
      <span class="meta-item"><strong>gy</strong> {{ seat.graveyard.length }}</span>
      <span class="meta-item"><strong>exile</strong> {{ exileCards.length }}</span>
      <span class="meta-item"><strong>lands</strong> {{ untappedLands }}/{{ lands.length }}</span>
      <span v-if="seat.mulligansTaken > 0" class="meta-item"
        ><strong>mull</strong> {{ seat.mulligansTaken }}</span
      >
      <button
        type="button"
        class="zones-toggle"
        :aria-expanded="zonesExpanded"
        @click="zonesExpanded = !zonesExpanded"
      >
        {{ zonesExpanded ? '▾ zones' : '▸ zones' }}
      </button>
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

    <div class="battlefield-grid">
      <div class="battlefield-col nonlands-col" :style="{ flex: flexStyles.nonlandsFlex }">
        <div class="row-header">Board ({{ nonlands.length }})</div>
        <TransitionGroup tag="div" name="chip" class="chips-grid">
          <PermanentChip
            v-for="g in groupedNonlands"
            :key="g.permanent.id"
            :permanent="g.permanent"
            :count="g.count"
            :name-by-id="nameById"
          />
        </TransitionGroup>
      </div>
      <div class="battlefield-col lands-col" :style="{ flex: flexStyles.landsFlex }">
        <div class="row-header">Lands ({{ lands.length }})</div>
        <TransitionGroup tag="div" name="chip" class="chips-grid">
          <PermanentChip
            v-for="g in groupedLands"
            :key="g.permanent.id"
            :permanent="g.permanent"
            :count="g.count"
            :name-by-id="nameById"
          />
        </TransitionGroup>
      </div>
      <p v-if="permanents.length === 0" class="empty">no permanents on battlefield</p>
    </div>

    <!-- The hand is a one-line handle; hovering or focusing it pops the cards up over the board,
         so the battlefield keeps the height a permanent hand row took. -->
    <div class="hand-section" :tabindex="seat.hand.length > 0 ? 0 : undefined">
      <div class="hand-header">Hand ({{ seat.hand.length }})</div>
      <div v-if="seat.hand.length > 0" class="hand-popup">
        <HandStrip :cards="seat.hand" />
      </div>
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
  transition:
    border-color 0.25s,
    box-shadow 0.25s;
}
.seat.active {
  border-color: var(--accent);
  box-shadow:
    0 0 0 1px rgb(96 165 250 / 0.35),
    0 0 14px rgb(96 165 250 / 0.2);
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
.monarch-badge {
  flex-shrink: 0;
  color: #fbbf24;
  background: rgb(251 191 36 / 0.14);
  border: 1px solid rgb(251 191 36 / 0.45);
  border-radius: 999px;
  padding: 0.08rem 0.32rem;
  font-size: 0.52rem;
  font-weight: 800;
  letter-spacing: 0.05em;
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
.cmdr-thumb {
  width: 22px;
  flex-shrink: 0;
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid rgb(96 165 250 / 0.4);
  cursor: zoom-in;
}
.cmdr-tax {
  color: var(--warn);
  font-size: 0.7rem;
  font-weight: 700;
}
.label.has-preview {
  cursor: zoom-in;
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
/* Landscape art tiles: about five rows fit a seat panel now that the board has the window. */
.chips-grid {
  --chip-w: 120px;
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 0.3rem;
}
/* Token creation / death-and-zone-change feedback (§9.8.2): brief scale-in/fade-out rather than
   an instant appear/disappear. The reduced-motion global override collapses these to ~0s. */
.chip-enter-active,
.chip-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}
.chip-enter-from,
.chip-leave-to {
  opacity: 0;
  transform: scale(0.85);
}
.chip-leave-active {
  position: absolute;
}
.hand-section {
  position: relative;
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  padding-top: 0.25rem;
}
.hand-header {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--muted);
}
.hand-section[tabindex]:hover .hand-header,
.hand-section[tabindex]:focus-within .hand-header {
  color: var(--text);
}
/* Pops up over the board from the handle; the gap is bridged by padding so moving the pointer
   from the handle into the cards never drops the hover. */
.hand-popup {
  display: none;
  position: absolute;
  left: -0.3rem;
  right: -0.3rem;
  bottom: 100%;
  z-index: 20;
  padding-bottom: 0.3rem;
}
.hand-section:hover .hand-popup,
.hand-section:focus-within .hand-popup {
  display: block;
}
.hand-popup > :deep(*) {
  width: fit-content;
  box-sizing: border-box;
  padding: 0.4rem;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
}
/* Popped up, the cards are big enough to read; the board strip's 40px thumbs are not. */
.hand-popup :deep(.thumb) {
  width: 92px;
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
