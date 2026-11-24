<script setup lang="ts">
/**
 * The New game compass (Decktank `Main.dc.html`). Four stops on a plate that turns so the chosen
 * mode comes to north: Play (N) and Watch (W) choose the game mode, Batch (E) goes to the batch
 * page and Multiplayer (S) opens the hosted tables in a new tab (ADR 0052 decision 7). The bezel,
 * three rings and the eight-point rose are drawn as the design draws them; the rings spin about a
 * turn on each change and land square, and the needle leans toward a hovered stop.
 *
 * On the opening screen (`opening`) nothing is chosen yet: the stops sit at their compass points,
 * none pressed, the warm north blade and the lubber mark are hidden, and the needle swings in from
 * the west once. The plate around it (`OpeningGarnish`) is drawn only then.
 *
 * The stops are real buttons and links (Play and Watch with `aria-pressed`; left and right arrows
 * move between them). Every ring, rose and tick is decoration and hidden from assistive
 * technology. Under reduced motion nothing spins or drifts; a choice lands at once.
 */
import { LOCAL_GAMES } from '../../lib/localMode';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { StartGameMode } from '@mtg/shared';
import {
  bearing,
  needleLean,
  needleTarget,
  plateTarget,
  ringLanding,
  wrap,
} from '../../lib/compass';
import { HOSTED_TABLES_URL } from '../../lib/links';
import OpeningGarnish from './OpeningGarnish.vue';

const props = defineProps<{ modelValue: StartGameMode; disabled?: boolean; opening?: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [StartGameMode];
  /** Any pick of Play or Watch, including the one already chosen: it ends the opening. */
  choose: [StartGameMode];
}>();

interface Stop {
  key: string;
  point: string;
  label: string;
  sub: string;
  /** Where the stop sits on the plate, clockwise from north, before the plate turns. */
  angle: number;
  mode?: StartGameMode;
  to?: string;
  href?: string;
}

const STOPS: readonly Stop[] = [
  { key: 'play', point: 'N', label: 'Play', sub: '1 v 3', angle: 0, mode: 'singlePlayer' },
  {
    key: 'batch',
    point: 'E',
    label: 'Batch',
    // Batch runs need the server's database, which a local-games build has none of.
    sub: LOCAL_GAMES ? 'Coming soon' : 'Many games',
    angle: 90,
    to: '/batch',
  },
  {
    key: 'multi',
    point: 'S',
    label: 'Multiplayer',
    sub: 'Hosted tables',
    angle: 180,
    href: HOSTED_TABLES_URL,
  },
  { key: 'watch', point: 'W', label: 'Watch', sub: '4 bots', angle: 270, mode: 'spectator' },
];

const angleFor = (mode: StartGameMode): number =>
  STOPS.find((stop) => stop.mode === mode)?.angle ?? 0;

const plate = ref(props.opening === true ? 0 : -angleFor(props.modelValue));
const rings = ref<[number, number, number]>([0, 0, 0]);
/** The needle starts in the west and swings home once the face has painted. */
const needle = ref(-120);
const booted = ref(false);
const held = ref<number | null>(null);
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;

function kickRings(): void {
  rings.value = [
    ringLanding(rings.value[0], 1),
    ringLanding(rings.value[1], -1),
    ringLanding(rings.value[2], 1),
  ];
}

function boot(): void {
  booted.value = false;
  needle.value = -120;
  if (bootTimer !== null) clearTimeout(bootTimer);
  bootTimer = setTimeout(() => {
    booted.value = true;
    needle.value = 0;
  }, 150);
}
onMounted(boot);

watch(
  () => [props.modelValue, props.opening] as const,
  ([mode, opening], [, wasOpening]) => {
    plate.value = plateTarget(plate.value, opening === true ? 0 : angleFor(mode));
    kickRings();
    pointNeedle(0);
    // Back to the opening plate: swing the needle in again.
    if (opening === true && wasOpening !== true) boot();
  },
);

/** Where a stop is now on the face, after the plate's turn. */
const faceAngle = (stop: Stop): number => wrap(stop.angle + plate.value);

function pointNeedle(angle: number): void {
  if (!booted.value) return;
  needle.value = needleTarget(needle.value, angle);
}

function cancelLeave(): void {
  if (leaveTimer !== null) clearTimeout(leaveTimer);
  leaveTimer = null;
}
function hoverStop(stop: Stop): void {
  cancelLeave();
  held.value = faceAngle(stop);
  pointNeedle(held.value);
}
/** Leaving a stop waits a moment, so crossing between stops doesn't swing the needle home. */
function softLeave(): void {
  cancelLeave();
  leaveTimer = setTimeout(() => {
    held.value = null;
    pointNeedle(0);
  }, 40);
}
onBeforeUnmount(() => {
  cancelLeave();
  if (bootTimer !== null) clearTimeout(bootTimer);
});

const face = ref<HTMLElement | null>(null);
function onFaceMove(event: PointerEvent): void {
  if (event.pointerType === 'touch' || face.value === null) return;
  if ((event.target as HTMLElement).closest('.stop')) return;
  const box = face.value.getBoundingClientRect();
  const dx = event.clientX - (box.left + box.width / 2);
  const dy = event.clientY - (box.top + box.height / 2);
  if (Math.hypot(dx, dy) > box.width / 2) return;
  cancelLeave();
  const lean = needleLean(
    bearing(dx, dy),
    STOPS.filter((stop) => stop.key !== 'multi').map(faceAngle),
    held.value,
  );
  held.value = lean.held;
  pointNeedle(lean.angle);
}

function pick(stop: Stop): void {
  if (stop.mode === undefined || props.disabled === true) return;
  emit('update:modelValue', stop.mode);
  emit('choose', stop.mode);
}

/** Left and right arrows move between the two modes. */
function onKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const modes = STOPS.filter((stop) => stop.mode !== undefined);
  const at = modes.findIndex((stop) => stop.mode === props.modelValue);
  const next = modes[(at + (event.key === 'ArrowRight' ? 1 : modes.length - 1)) % modes.length];
  if (next === undefined) return;
  event.preventDefault();
  pick(next);
  const button = face.value?.querySelector<HTMLElement>(`[data-stop="${next.key}"]`);
  button?.focus();
}

const pressed = (stop: Stop): boolean =>
  props.opening !== true && stop.mode !== undefined && stop.mode === props.modelValue;

const plateStyle = computed(() => ({ transform: `rotate(${plate.value}deg)` }));
const ringStyle = (i: 0 | 1 | 2) => ({ transform: `rotate(${rings.value[i]}deg)` });
const needleStyle = computed(() => ({
  transform: `rotate(${needle.value}deg)`,
  transition: booted.value ? undefined : 'none',
}));
/** A stop sits on the plate at its own angle, and turns back against the plate to stay upright. */
const R = 34.5;
const stopStyle = (stop: Stop, i: number) => {
  const radians = (stop.angle * Math.PI) / 180;
  return {
    left: `${50 + R * Math.sin(radians)}%`,
    top: `${50 - R * Math.cos(radians)}%`,
    transform: `translate(-50%, -50%) rotate(${-plate.value}deg)`,
    animationDelay: `${0.2 + i * 0.06}s`,
  };
};

/** The instrument's lines, as `Main.dc.html` draws them on a 400 × 400 face. */
const C = 200;
function at(deg: number, radius: number): string {
  const t = (deg * Math.PI) / 180;
  return `${+(C + radius * Math.sin(t)).toFixed(1)} ${+(C - radius * Math.cos(t)).toFixed(1)}`;
}
function tickPath(step: number, outer: number, inner: (deg: number) => number): string {
  let d = '';
  for (let deg = 0; deg < 360; deg += step) d += `M${at(deg, outer)} L${at(deg, inner(deg))} `;
  return d;
}
const OUTER_TICKS = tickPath(5, 190, (d) =>
  d % 90 === 0 ? 162 : d % 30 === 0 ? 172 : d % 15 === 0 ? 177 : 183,
);
const MID_TICKS = tickPath(15, 150, (d) => (d % 90 === 0 ? 136 : d % 45 === 0 ? 141 : 145));
const INNER_TICKS = tickPath(30, 104, (d) => (d % 90 === 0 ? 114 : 109));
const ROSE = (() => {
  let light = '';
  let dark = '';
  for (let d = 0; d < 360; d += 45) {
    const tip = at(d, d % 90 === 0 ? 100 : 64);
    light += `M${C} ${C} L${tip} L${at(d - 45, 15)} Z `;
    dark += `M${C} ${C} L${tip} L${at(d + 45, 15)} Z `;
  }
  return { light, dark };
})();
</script>

<template>
  <div
    ref="face"
    class="compass"
    :class="{ opening }"
    role="group"
    aria-label="Mode"
    @pointermove="onFaceMove"
    @pointerleave="softLeave"
    @keydown="onKey"
  >
    <Transition name="garnish">
      <OpeningGarnish v-if="opening" />
    </Transition>

    <svg class="layer" viewBox="0 0 400 400" aria-hidden="true">
      <circle cx="200" cy="200" r="196" class="bezel" />
    </svg>
    <svg class="layer ring" viewBox="0 0 400 400" aria-hidden="true" :style="ringStyle(0)">
      <circle cx="200" cy="200" r="190" class="hair fade-1" />
      <path :d="OUTER_TICKS" class="hair fade-0" />
      <path d="M200 10 L200 34 M390 200 L366 200 M200 390 L200 366 M10 200 L34 200" class="mark" />
    </svg>
    <svg class="layer ring mid" viewBox="0 0 400 400" aria-hidden="true" :style="ringStyle(1)">
      <circle cx="200" cy="200" r="150" class="hair dashed fade-2" />
      <path :d="MID_TICKS" class="hair fade-2" />
      <path d="M200 50 L200 70 M350 200 L330 200 M200 350 L200 330 M50 200 L70 200" class="mark" />
    </svg>
    <svg class="layer ring inner" viewBox="0 0 400 400" aria-hidden="true" :style="ringStyle(2)">
      <circle cx="200" cy="200" r="104" class="hair dotted fade-3" />
      <path :d="INNER_TICKS" class="hair fade-3" />
      <path d="M200 96 L200 80 M304 200 L320 200 M200 304 L200 320 M96 200 L80 200" class="mark" />
    </svg>
    <svg class="layer" viewBox="0 0 400 400" aria-hidden="true">
      <g class="rose">
        <path :d="ROSE.light" class="petal-light" />
        <path :d="ROSE.dark" class="petal-dark" />
        <path d="M200 94 L213 189 L200 200 L187 189 Z" class="blade chosen" />
        <circle cx="200" cy="200" r="22" class="hub" />
      </g>
      <path d="M200 14 L205 4 L195 4 Z" class="lubber chosen" />
    </svg>
    <svg class="layer needle" viewBox="0 0 400 400" aria-hidden="true" :style="needleStyle">
      <path d="M200 112 L206.5 200 L200 209 L193.5 200 Z" class="needle-head" />
      <path d="M200 284 L205.5 200 L200 191 L194.5 200 Z" class="needle-tail" />
      <circle cx="200" cy="200" r="7" class="needle-pin" />
      <circle cx="200" cy="200" r="2.5" class="needle-dot" />
    </svg>

    <div class="plate" :style="plateStyle">
      <template v-for="(stop, i) in STOPS" :key="stop.key">
        <button
          v-if="stop.mode"
          type="button"
          class="stop"
          :data-stop="stop.key"
          :style="stopStyle(stop, i)"
          :aria-pressed="pressed(stop)"
          :disabled="disabled"
          @click="pick(stop)"
          @mouseenter="hoverStop(stop)"
          @mouseleave="softLeave"
          @focus="hoverStop(stop)"
          @blur="softLeave"
        >
          <span class="point" aria-hidden="true">{{ stop.point }}</span>
          <span class="label">{{ stop.label }}</span>
          <span class="sub">{{ stop.sub }}</span>
        </button>
        <RouterLink
          v-else-if="stop.to"
          :to="stop.to"
          class="stop"
          :data-stop="stop.key"
          :style="stopStyle(stop, i)"
          @mouseenter="hoverStop(stop)"
          @mouseleave="softLeave"
          @focus="hoverStop(stop)"
          @blur="softLeave"
        >
          <span class="point" aria-hidden="true">{{ stop.point }}</span>
          <span class="label">{{ stop.label }}</span>
          <span class="sub">{{ stop.sub }}</span>
        </RouterLink>
        <a
          v-else
          :href="stop.href"
          target="_blank"
          rel="noopener"
          class="stop faint"
          :data-stop="stop.key"
          :style="stopStyle(stop, i)"
        >
          <span class="point" aria-hidden="true">{{ stop.point }}</span>
          <span class="label">{{ stop.label }} <span class="ext" aria-hidden="true">↗</span></span>
          <span class="sub">{{ stop.sub }}</span>
          <span class="dt-sr">(opens in a new tab)</span>
        </a>
      </template>
    </div>
  </div>
</template>

<style scoped>
.compass {
  position: relative;
  width: min(100%, 64vh, 680px);
  min-width: 280px;
  aspect-ratio: 1 / 1;
  margin: 0 auto;
  user-select: none;
  transform-origin: 50% 0;
  transition: transform 1s var(--ease);
}
.compass.opening {
  transform: scale(1.16);
}
.layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.bezel {
  fill: var(--paper);
  stroke: var(--ink);
  stroke-width: 3;
  stroke-dasharray: 1232;
  transform: rotate(-90deg);
  transform-origin: 200px 200px;
  animation: compassDraw 1s var(--ease) both;
}
.hair {
  fill: none;
  stroke: var(--ink);
  stroke-width: 1;
}
.dashed {
  stroke-dasharray: 6 5;
}
.dotted {
  stroke-dasharray: 1 4;
}
.mark {
  fill: none;
  stroke: var(--warm);
  stroke-width: 3.5;
  animation: compassFade 0.7s var(--ease) 0.8s both;
}
.fade-0 {
  animation: compassFade 0.7s var(--ease) 0.15s both;
}
.fade-1 {
  animation: compassFade 0.7s var(--ease) 0.35s both;
}
.fade-2 {
  animation: compassFade 0.7s var(--ease) 0.55s both;
}
.fade-3 {
  animation: compassFade 0.7s var(--ease) 0.65s both;
}
.ring {
  will-change: transform;
  transition: transform 1.7s cubic-bezier(0.3, 0.55, 0.25, 1);
}
.ring.mid {
  transition-duration: 1.5s;
}
.ring.inner {
  transition-duration: 1.1s;
}
.rose {
  transform-origin: 200px 200px;
  animation: compassRose 0.9s var(--ease) 0.2s both;
}
.petal-light {
  fill: color-mix(in srgb, var(--paper) 72%, var(--rule));
  stroke: var(--ink);
  stroke-width: 0.75;
  stroke-linejoin: round;
}
.petal-dark {
  fill: var(--rule);
  stroke: var(--ink);
  stroke-width: 0.75;
  stroke-linejoin: round;
}
.blade {
  fill: var(--warm);
  stroke: var(--ink);
  stroke-width: 0.75;
  stroke-linejoin: round;
}
.hub {
  fill: var(--paper);
  stroke: var(--ink);
  stroke-width: 1;
}
.lubber {
  fill: var(--ink);
}
.chosen {
  transition: opacity 0.6s var(--ease) 0.3s;
}
.opening .chosen {
  opacity: 0;
  transition-delay: 0s;
}
.needle {
  transition: transform 1.1s var(--ease);
}
.needle-head {
  fill: var(--ink);
  stroke: var(--ink);
  stroke-width: 1;
  stroke-linejoin: round;
}
.needle-tail {
  fill: var(--paper);
  stroke: var(--ink);
  stroke-width: 1;
  stroke-linejoin: round;
}
.needle-pin {
  fill: var(--ink);
}
.needle-dot {
  fill: var(--paper);
}
.plate {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  will-change: transform;
  transition: transform 1.25s var(--ease);
}
.stop {
  position: absolute;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.1rem;
  min-width: 64px;
  min-height: 44px;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--ink);
  outline-offset: -4px;
  background: var(--paper);
  color: var(--ink);
  text-decoration: none;
  cursor: pointer;
  animation: stopIn 0.6s var(--ease) both;
  transition:
    transform 1.25s var(--ease),
    background-color 0.3s var(--ease),
    color 0.3s var(--ease),
    border-color 0.3s var(--ease);
}
.stop:hover:not(:disabled) {
  border-width: 2px;
  padding: calc(0.3rem - 1px) calc(0.6rem - 1px);
}
.stop[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
.stop[aria-pressed='true']:hover:not(:disabled) {
  border-width: 1px;
  padding: 0.3rem 0.6rem;
  background: var(--ink-soft);
  outline: 1px solid var(--paper);
}
.stop.faint {
  border-color: color-mix(in srgb, var(--ink) 40%, transparent);
  color: var(--muted);
}
.point {
  font-family: var(--font-display);
  font-size: 1.15rem;
  line-height: 1;
}
.label {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}
.sub {
  font-family: var(--font-body);
  font-size: 0.6rem;
  letter-spacing: 0.06em;
  white-space: nowrap;
  opacity: 0.85;
}
.ext {
  font-size: 0.8em;
}
.garnish-leave-active,
.garnish-enter-active {
  transition: opacity 0.6s var(--ease);
}
.garnish-enter-from,
.garnish-leave-to {
  opacity: 0;
}
@keyframes compassDraw {
  from {
    stroke-dashoffset: 1232;
  }
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes compassFade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes compassRose {
  from {
    opacity: 0;
    transform: scale(0.55) rotate(-22deg);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes stopIn {
  from {
    opacity: 0;
    scale: 0.85;
  }
  to {
    opacity: 1;
    scale: 1;
  }
}
:global(.reduced-motion) .compass * {
  animation: none !important;
  transition: none !important;
}
@media (prefers-reduced-motion: reduce) {
  .compass,
  .compass * {
    animation: none !important;
    transition: none !important;
  }
}
@media (max-width: 900px) {
  .compass,
  .compass.opening {
    width: min(100%, 52vh, 480px);
    transform: none;
  }
}
@media (max-width: 520px) {
  .stop {
    min-width: 3.6rem;
    padding: 0.25rem 0.4rem;
  }
  .sub {
    display: none;
  }
}
</style>
