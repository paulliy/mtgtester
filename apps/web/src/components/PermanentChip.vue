<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { SpectatorPermanent } from '@mtg/shared';
import { useBoardAnchors } from '../composables/useBoardAnchors';
import { useBoardFlash } from '../composables/useBoardFlash';
import { STRIKE_MS, useCombatStrikes } from '../composables/useCombatStrikes';
import { isTokenTypeLine, scryfallImageUrl } from '../lib/card';
import type { TokenArtKey } from '../lib/tokenArt';
import { useCardPreviewStore } from '../stores/cardPreview';
import { useTokenArtStore } from '../stores/tokenArt';

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
const tokenArtStore = useTokenArtStore();
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

/**
 * Counters drawn as pips rather than words: +1/+1 and -1/-1 as signed green and red numbers,
 * loyalty as a plain number, anything else as its initial and count. The words are on hover.
 */
const counterPips = computed(() =>
  Object.entries(props.permanent.counters)
    .filter(([, n]) => n !== 0)
    .map(([kind, n]) => {
      const title = `${n} ${kind} counter${n === 1 ? '' : 's'}`;
      if (kind === '+1/+1') return { kind, label: `+${n}`, tone: 'plus', title };
      if (kind === '-1/-1') return { kind, label: `-${n}`, tone: 'minus', title };
      if (kind === 'loyalty') return { kind, label: `${n}`, tone: 'loyalty', title };
      return { kind, label: `${kind.charAt(0).toUpperCase()}${n}`, tone: 'other', title };
    }),
);

/** The tile shows these states (rotation, a desaturated or lifted card, glows); hover names them. */
const statusLines = computed(() => {
  const p = props.permanent;
  const out: string[] = [];
  if (p.tapped) out.push('Tapped');
  if (p.summoningSick && isCreature.value) out.push('Summoning sick');
  if (p.attacking !== null)
    out.push(`Attacking ${props.nameById?.get(p.attacking) ?? p.attacking}`);
  if (p.blocking !== null) out.push(`Blocking ${props.nameById?.get(p.blocking) ?? p.blocking}`);
  return out;
});

/** Marked damage as a red wash rising from the foot of the art, in proportion to toughness. */
const damageShare = computed(() => {
  const { damageMarked, toughness } = props.permanent;
  if (damageMarked <= 0) return 0;
  if (toughness === null || toughness <= 0) return 0.5;
  return Math.min(1, damageMarked / toughness);
});

/**
 * Arena-style tiles: a real card shows only its illustration (Scryfall's `art_crop`) in a landscape
 * rectangle; the full card, with its text and live state, is the hover preview. A token is an arch
 * carrying its P/T (or its name, when it isn't a creature) over art: a token copy of a real card
 * shows that card's, and any other token borrows a matching printed token's (`tokenArt`).
 */
const tokenArtKey = computed<TokenArtKey | null>(() => {
  const p = props.permanent;
  // Colors pick the right printing; a snapshot saved before they were sent can't be matched.
  if (!isToken.value || p.scryfallId !== null || p.colors === undefined) return null;
  return {
    name: p.name,
    typeLine: p.typeLine,
    colors: p.colors,
    power: p.power,
    toughness: p.toughness,
  };
});
const tokenArt = computed(() =>
  tokenArtKey.value === null ? null : (tokenArtStore.lookup(tokenArtKey.value) ?? null),
);
/** The printing this tile draws from: its own, or a borrowed token printing. */
const printing = computed(() =>
  props.permanent.scryfallId !== null
    ? { scryfallId: props.permanent.scryfallId, face: props.permanent.imageFace ?? 'front' }
    : tokenArt.value === null
      ? null
      : { scryfallId: tokenArt.value.scryfallId, face: tokenArt.value.face },
);
const artFailed = ref(false);
watch(
  () => [printing.value?.scryfallId, printing.value?.face],
  () => {
    artFailed.value = false;
  },
);
const artSrc = computed(() => {
  const p = printing.value;
  if (artFailed.value || p === null || p.scryfallId.length < 2) return null;
  return scryfallImageUrl(p.scryfallId, 'art_crop', p.face);
});

const ptText = computed(() =>
  isCreature.value ? `${props.permanent.power}/${props.permanent.toughness}` : null,
);
const hurt = computed(() => props.permanent.damageMarked > 0);

function onEnter(event: MouseEvent): void {
  const p = props.permanent;
  // A borrowed token printing shows whole only when it matched on P/T too; otherwise the preview
  // falls back to the token's own text rather than a card with the wrong numbers.
  const exactArt = tokenArt.value?.exact === true ? tokenArt.value : null;
  cardPreview.show({
    scryfallId: p.scryfallId ?? exactArt?.scryfallId ?? null,
    name: p.name,
    imageFace: p.scryfallId !== null ? (p.imageFace ?? 'front') : (exactArt?.face ?? 'front'),
    typeLine: p.typeLine,
    manaCost: p.manaCost,
    oracleText: p.oracleText,
    power: p.power,
    toughness: p.toughness,
    keywords: p.keywords,
    counters: counterText.value,
    damageMarked: p.damageMarked,
    status: statusLines.value,
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
      tapped: permanent.tapped,
      sick: permanent.summoningSick && isCreature,
      attacking: isAttacking,
      blocking: permanent.blocking !== null,
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
    <!-- Everything on the card turns with it when it taps, name and P/T included. -->
    <div class="card">
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
          v-if="damageShare > 0"
          class="damage-wash"
          :style="{ height: `${damageShare * 100}%` }"
          aria-hidden="true"
        />
        <span
          v-if="isToken"
          class="token-label"
          :class="{
            'is-name': ptText === null,
            'on-art': artSrc !== null,
            'flash-damage': damageFlash === 'damage',
          }"
        >
          <template v-if="ptText === null">{{ permanent.name }}</template>
          <template v-else
            >{{ permanent.power }}/<span :class="{ hurt }">{{
              permanent.toughness
            }}</span></template
          >
        </span>
      </div>
      <!-- Hidden from screen readers, which already hear the name from the frame's label. -->
      <span v-if="artSrc && !isToken" class="name-strip" aria-hidden="true">
        {{ permanent.name }}
      </span>
      <span
        v-if="ptText !== null && !isToken"
        class="pt"
        :class="{ 'above-name': artSrc !== null, 'flash-damage': damageFlash === 'damage' }"
        >{{ permanent.power }}/<span :class="{ hurt }">{{ permanent.toughness }}</span></span
      >
      <div v-if="counterPips.length > 0" class="pips" aria-hidden="true">
        <span
          v-for="pip in counterPips"
          :key="pip.kind"
          class="pip"
          :class="pip.tone"
          :title="pip.title"
        >
          {{ pip.label }}
        </span>
      </div>
    </div>
    <!-- The tile shows these states without words; this text keeps them for anyone who can't see
         or hover the card. -->
    <span v-if="permanent.tapped" class="tap-badge visually-hidden">TAP</span>
    <span v-if="permanent.damageMarked > 0" class="dmg visually-hidden">
      −{{ permanent.damageMarked }}
    </span>
    <span v-if="counterText" class="counters visually-hidden">{{ counterText }}</span>
    <span v-if="statusLines.length > 0" class="marks visually-hidden">
      {{ statusLines.join(', ') }}
    </span>
    <span
      v-if="permanent.keywords.length > 0"
      class="keywords visually-hidden"
      :title="permanent.keywords.join(', ')"
    >
      {{ permanent.keywords.join(', ') }}
    </span>
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
/* An arch: a half-circle across the top of the same landscape footprint as a card. */
.tile.token {
  --tile-radius: 50% 50% 0 0 / 66.7% 66.7% 0 0;
}
.card {
  position: relative;
  transition:
    transform 180ms ease,
    translate 150ms ease;
}
/* Tapped: the whole card turns sideways, like the real thing, scaled so it stays in its slot. */
.tile.tapped .card {
  transform: rotate(90deg) scale(0.75);
}
/* Attacking: the card steps forward. */
.tile.attacking .card {
  translate: 0 -5px;
}
.frame {
  position: relative;
  aspect-ratio: 4 / 3;
  box-sizing: border-box;
  border-radius: var(--tile-radius);
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--line);
  transition: box-shadow 150ms ease;
}
.frame img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: filter 200ms ease;
}
.tile.tapped .frame img {
  filter: brightness(0.82);
}
/* Summoning sick: the art drains of color until the creature can act. */
.tile.sick .frame img {
  filter: grayscale(0.85) brightness(0.8);
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
.damage-wash {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(to top, rgb(220 38 38 / 0.6), rgb(220 38 38 / 0.2));
  border-top: 1px solid rgb(254 202 202 / 0.7);
  pointer-events: none;
  transition: height 250ms ease;
}
.tile.token .frame {
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
/* Over art, the label sits on a dark pill so it reads against any illustration. */
.token-label.on-art {
  margin-bottom: 4%;
  padding: 0.05rem 0.4rem;
  border-radius: 6px;
  background: rgb(11 13 17 / 0.82);
  color: #fff;
  text-shadow: none;
}
.token-label.is-name {
  max-width: 80%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: max(0.6rem, 12cqw);
  font-weight: 700;
}
.tile.attacking .frame {
  border-color: var(--danger);
  box-shadow:
    0 0 0 2px rgb(248 113 113 / 0.7),
    0 6px 14px rgb(248 113 113 / 0.45);
  animation: attackPulse 1s ease-in-out infinite;
}
.tile.blocking .frame {
  border-color: #93c5fd;
  box-shadow:
    0 0 0 2px rgb(96 165 250 / 0.8),
    0 0 12px rgb(96 165 250 / 0.5);
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
/* Outside the card, so the count stays upright when the stack taps. */
.stack-count-badge {
  position: absolute;
  top: -5px;
  right: -5px;
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
/* A tapped card is 9/16 of the slot wide, centered: keep the count on its corner. */
.tile.tapped .stack-count-badge {
  right: calc(21.9% - 5px);
}
/* The card's name across the foot of its art, like the title bar of a printed card. */
.name-strip {
  --name-size: max(0.6rem, 10.5cqw);
  position: absolute;
  left: 1px;
  right: 1px;
  bottom: 1px;
  z-index: 1;
  padding: 3px 5px;
  border-radius: 0 0 7px 7px;
  background: rgb(11 13 17 / 0.78);
  color: #fff;
  font-size: var(--name-size);
  font-weight: 600;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
/* The P/T box sits in the art's bottom-right corner, as on a printed card, just above the name. */
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
.pt.above-name {
  bottom: calc(max(0.6rem, 10.5cqw) * 1.15 + 9px);
}
/* Damaged toughness turns red, as in Arena. */
.hurt {
  color: #fca5a5;
}
.token-label:not(.on-art) .hurt {
  color: var(--danger);
}
.pt.flash-damage,
.token-label.flash-damage {
  animation: flash 0.8s ease-out;
}
/* Counter pips sit top-left, clear of the P/T box in the bottom-right corner. */
.pips {
  position: absolute;
  left: 3px;
  top: 3px;
  max-width: calc(100% - 6px);
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  pointer-events: none;
}
/* Inside an arch's curve, the top-left corner is outside the shape: center them under the dome. */
.tile.token .pips {
  top: 22%;
  left: 0;
  right: 0;
  max-width: none;
  justify-content: center;
}
.pip {
  min-width: 1.1rem;
  padding: 0 0.22rem;
  border-radius: 999px;
  box-sizing: border-box;
  border: 1px solid rgb(255 255 255 / 0.6);
  background: rgb(11 13 17 / 0.85);
  color: #fff;
  font-size: max(0.58rem, 9.5cqw);
  font-weight: 800;
  line-height: 1.35;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.pip.plus {
  background: #15803d;
  border-color: #bbf7d0;
}
.pip.minus {
  background: #b91c1c;
  border-color: #fecaca;
}
.pip.loyalty {
  background: #4c1d95;
  border-color: #ddd6fe;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
