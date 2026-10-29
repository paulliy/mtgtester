<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { SpectatorPermanent } from '@mtg/shared';
import { useBoardAnchors } from '../composables/useBoardAnchors';
import { useBoardFlash } from '../composables/useBoardFlash';
import { STRIKE_MS, useCombatStrikes } from '../composables/useCombatStrikes';
import { scryfallImageUrl } from '../lib/card';
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
/** The engine's flag. A snapshot saved before it existed lacks it and shows no token art. */
const isToken = computed(() => props.permanent.isToken === true);
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
 * Counters drawn as a number per kind in the bottom-right corner, as in Arena, colored by kind:
 * green +1/+1, red -1/-1, purple loyalty, blue for anything else. The words are on hover.
 */
const COUNTER_TONES: Record<string, string> = {
  '+1/+1': 'plus',
  '-1/-1': 'minus',
  loyalty: 'loyalty',
};
const counterPips = computed(() =>
  Object.entries(props.permanent.counters)
    .filter(([, n]) => n !== 0)
    .map(([kind, n]) => ({
      kind,
      count: n,
      tone: COUNTER_TONES[kind] ?? 'other',
      title: `${n} ${kind} counter${n === 1 ? '' : 's'}`,
    })),
);

/**
 * The frame's border shows the card's colors, as a printed frame does: one color solid, several
 * as bands of each, colorless (artifacts, lands) as silver.
 */
const FRAME_COLORS: Record<string, string> = {
  W: '#efe4bf',
  U: '#3f8fe0',
  B: '#8b7f99',
  R: '#e2533c',
  G: '#3ea85e',
};
const framePaint = computed(() => {
  const colors = (props.permanent.colors ?? []).map((c) => FRAME_COLORS[c]).filter(Boolean);
  if (colors.length === 0) return 'linear-gradient(#a8a29e, #a8a29e)';
  if (colors.length === 1) return `linear-gradient(${colors[0]}, ${colors[0]})`;
  const step = 100 / colors.length;
  const stops = colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`);
  return `linear-gradient(135deg, ${stops.join(', ')})`;
});

/** The tile shows these states (rotation, a desaturated or lifted card, glows); hover names them. */
const statusLines = computed(() => {
  const p = props.permanent;
  const out: string[] = [];
  if (p.tapped) out.push('Tapped');
  if (p.summoningSick && isCreature.value) out.push('Summoning sick');
  if (p.attacking !== null) {
    // An attack on a planeswalker names the planeswalker, not its controller.
    const target = p.attackingPlaneswalker ?? p.attacking;
    out.push(`Attacking ${props.nameById?.get(target) ?? target}`);
  }
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
    :style="{
      '--frame-paint': framePaint,
      ...(strike
        ? {
            '--strike-dx': strike.dx + 'px',
            '--strike-dy': strike.dy + 'px',
            '--strike-ms': `${STRIKE_MS}ms`,
          }
        : {}),
    }"
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
            pt: ptText !== null,
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
      <!-- Bottom-right, as in Arena: a number per counter kind, then the P/T box. -->
      <div
        v-if="counterPips.length > 0 || (ptText !== null && !isToken)"
        class="corner"
        :class="{ 'on-token': isToken }"
      >
        <span
          v-for="pip in counterPips"
          :key="pip.kind"
          class="pip"
          :class="pip.tone"
          :title="pip.title"
          aria-hidden="true"
        >
          {{ pip.count }}
        </span>
        <span
          v-if="ptText !== null && !isToken"
          class="pt"
          :class="{ 'flash-damage': damageFlash === 'damage' }"
          >{{ permanent.power }}/<span :class="{ hurt }">{{ permanent.toughness }}</span></span
        >
      </div>
      <!-- Summoning sick: Zs drift up off the card until it can act. Drawn by CSS, so the tile's
           text stays its name, P/T and counters. -->
      <div v-if="permanent.summoningSick && isCreature" class="zzz" aria-hidden="true">
        <span /><span /><span />
      </div>
    </div>
    <!-- The tile shows these states without words; this text keeps them for anyone who can't see
         or hover the card. -->
    <span v-if="permanent.tapped" class="tap-badge visually-hidden" title="Tapped">TAP</span>
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
  /* The border paints the card's colors (`--frame-paint`, set per tile), like a printed frame. */
  border: 3px solid transparent;
  background:
    linear-gradient(var(--surface-2), var(--surface-2)) padding-box,
    var(--frame-paint, linear-gradient(#a8a29e, #a8a29e)) border-box;
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
/* Summoning sick: the art drains of color and slowly dims and brightens, as if dozing, while Zs
   drift up off the card until the creature can act. */
.tile.sick .frame img {
  filter: grayscale(0.85) brightness(0.8);
  animation: doze 2.4s ease-in-out infinite;
}
@keyframes doze {
  50% {
    filter: grayscale(0.85) brightness(0.62);
  }
}
.zzz {
  position: absolute;
  right: 6%;
  top: 24%;
  width: 40%;
  height: 40%;
  z-index: 3;
  pointer-events: none;
}
.zzz span {
  position: absolute;
  left: 0;
  bottom: 0;
  opacity: 0;
  font-size: max(0.85rem, 18cqw);
  font-style: italic;
  font-weight: 900;
  line-height: 1;
  color: #fff;
  -webkit-text-stroke: 1px #0b0d11;
  text-shadow:
    0 0 4px rgb(11 13 17 / 0.9),
    0 0 10px rgb(56 189 248 / 0.9);
  animation: zzzFloat 2.4s ease-out infinite;
}
.zzz span::before {
  content: 'z';
}
.zzz span:nth-child(2) {
  animation-delay: 0.8s;
}
.zzz span:nth-child(3) {
  animation-delay: 1.6s;
}
.zzz span:nth-child(3)::before {
  content: 'Z';
}
/* With motion reduced the Zs stand still, climbing the corner, rather than vanish. */
:global(.reduced-motion) .zzz span {
  opacity: 1;
}
:global(.reduced-motion) .zzz span:nth-child(2) {
  transform: translate(50%, -60%);
}
:global(.reduced-motion) .zzz span:nth-child(3) {
  transform: translate(100%, -120%);
}
@keyframes zzzFloat {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.6) rotate(-12deg);
  }
  20% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translate(100%, -90%) scale(1.3) rotate(8deg);
  }
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
  background:
    radial-gradient(circle at 50% 100%, var(--surface) 0%, var(--surface-2) 70%) padding-box,
    var(--frame-paint, linear-gradient(#a8a29e, #a8a29e)) border-box;
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
/* The border keeps the card's colors in combat; the glow around it carries the state. */
.tile.attacking .frame {
  box-shadow:
    0 0 0 2px rgb(248 113 113 / 0.7),
    0 6px 14px rgb(248 113 113 / 0.45);
  animation: attackPulse 1s ease-in-out infinite;
}
.tile.blocking .frame {
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
/* The card's name across the top of its art, like the title bar of a printed card. */
.name-strip {
  --name-size: max(0.6rem, 10.5cqw);
  position: absolute;
  left: 3px;
  right: 3px;
  top: 3px;
  z-index: 1;
  padding: 2px 5px 3px;
  border-radius: 5px 5px 0 0;
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
/* Counters and the P/T box share the art's bottom-right corner, as on a printed card. */
.corner {
  position: absolute;
  right: 5px;
  bottom: 5px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 3px;
  pointer-events: none;
}
/* An arch's P/T is its centered label, so its counters sit alone in the corner. */
.corner.on-token {
  bottom: 6px;
  right: 6px;
}
.corner .pt {
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
/* Damaged toughness turns red, as in Arena. */
.hurt {
  color: #fca5a5;
}
.token-label:not(.on-art) .hurt {
  color: var(--danger);
}
.corner .pt.flash-damage,
.token-label.flash-damage {
  animation: flash 0.8s ease-out;
}
/* A counter is just its number in a circle; blue unless its kind has a color of its own. */
.pip {
  min-width: max(1.15rem, 15cqw);
  height: max(1.15rem, 15cqw);
  padding: 0 0.2rem;
  border-radius: 999px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid rgb(255 255 255 / 0.85);
  background: radial-gradient(circle at 35% 30%, #60a5fa, #1d4ed8);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.6);
  color: #fff;
  font-size: max(0.65rem, 10.5cqw);
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.pip.plus {
  background: radial-gradient(circle at 35% 30%, #4ade80, #15803d);
}
.pip.minus {
  background: radial-gradient(circle at 35% 30%, #f87171, #b91c1c);
}
.pip.loyalty {
  background: radial-gradient(circle at 35% 30%, #a78bfa, #4c1d95);
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
