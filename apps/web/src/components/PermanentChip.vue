<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { SpectatorPermanent } from '@mtg/shared';
import { useBoardAnchors } from '../composables/useBoardAnchors';
import { useBoardFlash } from '../composables/useBoardFlash';
import { STRIKE_MS, useCombatStrikes } from '../composables/useCombatStrikes';
import { isTokenTypeLine, scryfallImageUrl } from '../lib/card';
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
/** The engine's flag; older saved snapshots lack it, so fall back to the type line. */
const isToken = computed(
  () => props.permanent.isToken ?? isTokenTypeLine(props.permanent.typeLine),
);
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

/**
 * Arena-style tiles: a real card shows only its illustration (Scryfall's `art_crop`) in a square;
 * the full card, with its text and live state, is the hover preview. A token is a half-circle
 * carrying its P/T (or its name, when it isn't a creature); a token copy of a real card also
 * shows that card's art behind the label.
 */
const artFailed = ref(false);
watch(
  () => [props.permanent.scryfallId, props.permanent.imageFace],
  () => {
    artFailed.value = false;
  },
);
const artSrc = computed(() => {
  const id = props.permanent.scryfallId;
  if (artFailed.value || id === null || id.length < 2) return null;
  return scryfallImageUrl(id, 'art_crop', props.permanent.imageFace ?? 'front');
});

const ptText = computed(() =>
  isCreature.value ? `${props.permanent.power}/${props.permanent.toughness}` : null,
);

function onEnter(event: MouseEvent): void {
  const p = props.permanent;
  cardPreview.show({
    scryfallId: p.scryfallId,
    name: p.name,
    imageFace: p.imageFace ?? 'front',
    typeLine: p.typeLine,
    manaCost: p.manaCost,
    oracleText: p.oracleText,
    power: p.power,
    toughness: p.toughness,
    keywords: p.keywords,
    counters: counterText.value,
    damageMarked: p.damageMarked,
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
      token: isToken,
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
    <div class="frame" role="img" :aria-label="permanent.name">
      <img
        v-if="artSrc"
        :src="artSrc"
        alt=""
        loading="lazy"
        decoding="async"
        @error="artFailed = true"
      />
      <span v-else-if="!isToken" class="frame-name">{{ permanent.name }}</span>
      <span
        v-if="isToken"
        class="token-label"
        :class="{ 'is-name': ptText === null, 'flash-damage': damageFlash === 'damage' }"
      >
        {{ ptText ?? permanent.name }}
      </span>
    </div>
    <span
      v-if="ptText !== null && !isToken"
      class="pt"
      :class="{ 'flash-damage': damageFlash === 'damage' }"
    >
      {{ ptText }}
    </span>
    <span
      v-if="permanent.damageMarked > 0"
      class="dmg"
      :title="`${permanent.damageMarked} damage marked`"
    >
      −{{ permanent.damageMarked }}
    </span>
    <div v-if="counterText || marks.length > 0" class="status">
      <span v-if="counterText" class="counters">{{ counterText }}</span>
      <span v-if="marks.length > 0" class="marks">{{ marks.join(' ') }}</span>
    </div>
  </div>
</template>

<style scoped>
/*
 * `container-type` lets the labels below size themselves off the tile's own width (`cqw`): parents
 * shrink tiles with flexbox once a row runs out of room, so a fixed font size would overflow a
 * small tile and look lost on a large one.
 */
.tile {
  --tile-radius: 8px;
  position: relative;
  width: var(--chip-w, 108px);
  container-type: inline-size;
  transition:
    transform 120ms ease,
    width 150ms ease,
    opacity 200ms ease;
}
.tile.token {
  --tile-radius: 999px 999px 0 0;
}
.frame {
  position: relative;
  aspect-ratio: 1;
  box-sizing: border-box;
  border-radius: var(--tile-radius);
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--line);
  transition:
    transform 150ms ease,
    opacity 150ms ease;
}
.frame img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* Art that hasn't resolved (or never will) still names the card instead of showing a blank. */
.frame-name {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6%;
  text-align: center;
  font-size: max(0.6rem, 11cqw);
  font-weight: 600;
  line-height: 1.15;
  color: var(--text);
  overflow: hidden;
}
/* A half-circle: twice as wide as it is tall, rounded across the top. */
.tile.token .frame {
  aspect-ratio: 2 / 1;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  border: 2px solid var(--muted);
  border-bottom-width: 3px;
  background: radial-gradient(circle at 50% 100%, var(--surface) 0%, var(--surface-2) 70%);
}
.token-label {
  position: relative;
  z-index: 1;
  padding-bottom: 4%;
  text-shadow:
    0 0 4px var(--surface),
    0 1px 2px var(--surface);
  font-size: max(0.75rem, 20cqw);
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  white-space: nowrap;
}
.token-label.is-name {
  max-width: 80%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: max(0.6rem, 12cqw);
  font-weight: 700;
}
/* Tapped: an imaged card turns sideways, like the real thing. A half-circle can't turn inside its
   own footprint, so a tapped token dims and dashes its outline instead. The TAP badge marks both. */
.tile.tapped:not(.token) .frame {
  transform: rotate(90deg);
}
.tile.tapped .frame {
  opacity: 0.8;
}
.tile.token.tapped .frame {
  opacity: 0.6;
  border-style: dashed;
}
.tile.creature .frame {
  box-shadow: 0 0 0 2px var(--accent);
}
.tile.attacking .frame {
  border-color: var(--danger);
  box-shadow: 0 0 0 2px rgb(248 113 113 / 0.55);
  animation: attackPulse 1s ease-in-out infinite;
}
.tile.taking-damage::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 2px solid rgb(248 113 113 / 0.85);
  border-radius: var(--tile-radius);
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
.tile.token .tap-badge {
  top: -4px;
  right: -4px;
}
/* The P/T box sits in the art's bottom-right corner, as on a printed card. */
.pt {
  position: absolute;
  right: 3px;
  bottom: 3px;
  z-index: 2;
  padding: 0.05rem 0.35rem;
  border-radius: 5px;
  background: rgb(11 13 17 / 0.88);
  border: 1px solid rgb(255 255 255 / 0.55);
  color: #fff;
  font-size: max(0.65rem, 15cqw);
  font-weight: 800;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.pt.flash-damage,
.token-label.flash-damage {
  animation: flash 0.8s ease-out;
}
.dmg {
  position: absolute;
  right: 3px;
  top: 3px;
  z-index: 3;
  padding: 0.05rem 0.3rem;
  border-radius: 5px;
  background: #7f1d1d;
  color: #fecaca;
  font-size: max(0.6rem, 12cqw);
  font-weight: 800;
  pointer-events: none;
}
.tile.tapped .dmg {
  top: auto;
  bottom: 3px;
  right: auto;
  left: 3px;
}
.tile.token .dmg {
  top: -4px;
  right: auto;
  left: -4px;
}
.status {
  position: absolute;
  left: 3px;
  bottom: 3px;
  max-width: 60%;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  pointer-events: none;
}
.tile.token .status {
  bottom: auto;
  top: -2px;
  left: auto;
  right: 0;
  max-width: 45%;
  align-items: flex-end;
}
.counters,
.marks {
  max-width: 100%;
  padding: 0.02rem 0.25rem;
  border-radius: 4px;
  background: rgb(11 13 17 / 0.85);
  font-size: 0.6rem;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
