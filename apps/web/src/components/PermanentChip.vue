<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { SpectatorPermanent } from '@mtg/shared';
import CardImage from './CardImage.vue';
import { useBoardAnchors } from '../composables/useBoardAnchors';
import { useBoardFlash } from '../composables/useBoardFlash';
import { STRIKE_MS, useCombatStrikes } from '../composables/useCombatStrikes';
import { isTokenTypeLine } from '../lib/card';
import { useCardPreviewStore } from '../stores/cardPreview';

const props = withDefaults(
  defineProps<{
    permanent: SpectatorPermanent;
    count?: number;
    /** Object/card id → display name, for naming a blocked attacker. Optional; falls back to id. */
    nameById?: Map<string, string> | undefined;
  }>(),
  { count: 1 },
);

const cardPreview = useCardPreviewStore();
const { registerAnchor, unregisterAnchor } = useBoardAnchors();

const isCreature = computed(() => props.permanent.power !== null);
const isToken = computed(() => isTokenTypeLine(props.permanent.typeLine));
const isAttacking = computed(() => props.permanent.attacking !== null);

/** Board-change feedback (§9.8): a brief flash when this permanent takes or sheds damage. */
const damageFlash = useBoardFlash(
  () => props.permanent.damageMarked,
  (prev, next) => (next > prev ? 'damage' : null),
);

/**
 * MTGA-style attack animation: when this permanent is the striking side of a combat damage event
 * (`useCombatStrikes`), lunge toward its target and back. The `striking` class is toggled off and
 * on across a tick rather than keyed/remounted, so a retrigger (e.g. first strike then regular
 * damage) restarts the CSS animation without tearing down the card image mid-hover.
 */
const { strikeFor } = useCombatStrikes();
const strike = computed(() => strikeFor(props.permanent.id));
const striking = ref(false);
watch(
  () => strike.value?.key,
  async (key) => {
    if (key === undefined) return;
    striking.value = false;
    await nextTick();
    striking.value = true;
    setTimeout(() => {
      striking.value = false;
    }, STRIKE_MS);
  },
);

const tileEl = ref<HTMLElement | null>(null);
function setTileEl(el: Element | ComponentPublicInstance | null): void {
  tileEl.value = el instanceof HTMLElement ? el : null;
}
/** Anchor id is the permanent's object id, so the combat overlay can draw a line to it. */
watch(
  () => props.permanent.id,
  (next, prev) => {
    if (prev !== undefined && prev !== next) unregisterAnchor(prev);
    if (tileEl.value !== null) registerAnchor(next, tileEl.value);
  },
);
watch(tileEl, (el) => {
  if (el !== null) registerAnchor(props.permanent.id, el);
});
onBeforeUnmount(() => unregisterAnchor(props.permanent.id));

/** Counters render as `+1/+1×2`, which is denser than one chip per kind. */
const counterText = computed(() =>
  Object.entries(props.permanent.counters)
    .filter(([, n]) => n !== 0)
    .map(([kind, n]) => `${kind}×${n}`)
    .join(' '),
);

const marks = computed(() => {
  const out: string[] = [];
  if (props.permanent.attacking !== null) {
    out.push(`⚔ ${props.nameById?.get(props.permanent.attacking) ?? props.permanent.attacking}`);
  }
  if (props.permanent.blocking !== null) {
    out.push(`🛡 ${props.nameById?.get(props.permanent.blocking) ?? props.permanent.blocking}`);
  }
  if (props.permanent.summoningSick) out.push('zzz');
  return out;
});

function onEnter(event: MouseEvent): void {
  cardPreview.show({
    scryfallId: props.permanent.scryfallId,
    name: props.permanent.name,
    imageFace: props.permanent.imageFace ?? 'front',
  });
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onMove(event: MouseEvent): void {
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onLeave(): void {
  cardPreview.hide();
}
</script>

<template>
  <div
    :ref="setTileEl"
    class="tile"
    :class="{
      creature: isCreature,
      tapped: permanent.tapped,
      attacking: isAttacking,
      striking,
      'taking-damage': damageFlash === 'damage',
    }"
    :style="
      strike
        ? {
            '--strike-dx': strike.dx + 'px',
            '--strike-dy': strike.dy + 'px',
            '--strike-ms': `${STRIKE_MS}ms`,
          }
        : undefined
    "
    @mouseenter="onEnter"
    @mousemove="onMove"
    @mouseleave="onLeave"
  >
    <div
      v-if="count && count > 1"
      class="stack-count-badge"
      :title="`${count} copies of ${permanent.name}`"
    >
      ×{{ count }}
    </div>
    <div v-if="permanent.tapped" class="tap-badge" title="Tapped">TAP</div>
    <CardImage
      :scryfall-id="permanent.scryfallId"
      :name="permanent.name"
      :face="permanent.imageFace ?? 'front'"
      :is-token="isToken"
      size="small"
      :tapped="permanent.tapped"
    />
    <div
      v-if="permanent.keywords.length > 0"
      class="keywords"
      :title="permanent.keywords.join(', ')"
    >
      {{ permanent.keywords.join(' · ') }}
    </div>
    <div class="overlay">
      <span v-if="isCreature" class="pt" :class="{ 'flash-damage': damageFlash === 'damage' }">
        {{ permanent.power }}/{{ permanent.toughness }}
        <span v-if="permanent.damageMarked > 0" class="dmg">−{{ permanent.damageMarked }}</span>
      </span>
      <span v-if="counterText" class="counters">{{ counterText }}</span>
      <span v-if="marks.length > 0" class="marks">{{ marks.join(' ') }}</span>
    </div>
  </div>
</template>

<style scoped>
.tile {
  position: relative;
  width: var(--chip-w, 108px);
  transition:
    transform 120ms ease,
    width 150ms ease,
    opacity 200ms ease;
}
.tile.creature {
  box-shadow: 0 0 0 2px var(--accent);
  border-radius: 6%;
}
.tile.tapped {
  opacity: 0.85;
}
.tile.attacking {
  border-radius: 6%;
  box-shadow: 0 0 0 2px rgb(248 113 113 / 0.55);
  animation: attackPulse 1s ease-in-out infinite;
}
.tile.attacking :deep(.card-image) {
  outline: 1px solid var(--danger);
}
.tile.taking-damage::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 2px solid rgb(248 113 113 / 0.85);
  border-radius: 7%;
  box-shadow: 0 0 16px rgb(248 113 113 / 0.65);
  opacity: 0;
  pointer-events: none;
  animation: damageImpact 720ms ease-out;
}
.tile.striking {
  animation-name: strike;
  animation-duration: var(--strike-ms, 520ms);
  animation-timing-function: cubic-bezier(0.22, 0.68, 0.32, 1.15);
  animation-fill-mode: both;
  z-index: 6;
}
@keyframes strike {
  0% {
    transform: translate(0, 0) scale(1);
  }
  18% {
    transform: translate(0, -8px) scale(1.06);
  }
  48%,
  62% {
    transform: translate(var(--strike-dx, 0px), var(--strike-dy, 0px)) scale(1.14);
  }
  100% {
    transform: translate(0, 0) scale(1);
  }
}
@keyframes damageImpact {
  0% {
    opacity: 0;
    transform: scale(1.08);
  }
  20% {
    opacity: 1;
    transform: scale(0.98);
  }
  42% {
    opacity: 0.82;
    transform: scale(1.015);
  }
  100% {
    opacity: 0;
    transform: scale(1);
  }
}
.stack-count-badge {
  position: absolute;
  top: -5px;
  left: -5px;
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  color: #ffffff;
  border: 1.5px solid #ffffff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
  font-size: 0.65rem;
  font-weight: 800;
  padding: 0.08rem 0.35rem;
  border-radius: 10px;
  z-index: 10;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
}
.tap-badge {
  position: absolute;
  top: 3px;
  right: 3px;
  background: rgba(0, 0, 0, 0.8);
  color: var(--warn);
  border: 1px solid var(--warn);
  font-size: 0.52rem;
  font-weight: 700;
  padding: 0.05rem 0.2rem;
  border-radius: 3px;
  z-index: 2;
  pointer-events: none;
}
.keywords {
  position: absolute;
  inset: 0 0 auto 0;
  padding: 0.1rem 0.25rem;
  background: linear-gradient(to bottom, rgb(0 0 0 / 0.7), transparent);
  border-radius: 6% 6% 0 0;
  font-size: 0.58rem;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.overlay {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  padding: 0.15rem 0.25rem;
  background: linear-gradient(to top, rgb(0 0 0 / 0.75), transparent);
  border-radius: 0 0 6% 6%;
  pointer-events: none;
}
.pt {
  font-size: 0.68rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
  white-space: nowrap;
  border-radius: 3px;
}
.pt.flash-damage {
  animation: flash 0.8s ease-out;
}
.dmg {
  color: #ff8a80;
}
.counters,
.marks {
  font-size: 0.6rem;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
}
</style>
