<script setup lang="ts">
/**
 * The New game compass (redesign plan, phase 3a; `Main.dc.html`). Four stops on a plate that
 * turns so the chosen mode comes to north: Play and Watch choose the game mode; Batch goes to the
 * batch page; Multiplayer opens the hosted tables in a new tab (ADR 0052 decision 7) and never
 * turns the plate. Three rings spin about a turn on each change and land square, and the needle
 * leans toward a hovered stop or follows the pointer over the face.
 *
 * The stops are real buttons and links (Play and Watch with `aria-pressed`; left and right arrows
 * move between them). Every ring, rose and tick is decoration and hidden from assistive
 * technology. Under reduced motion nothing spins or drifts; a choice lands at once.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
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

const props = defineProps<{ modelValue: StartGameMode; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [StartGameMode] }>();

interface Stop {
  key: string;
  label: string;
  sub: string;
  /** Where the stop sits on the plate, clockwise from north, before the plate turns. */
  angle: number;
  mode?: StartGameMode;
  to?: string;
  href?: string;
}

const STOPS: readonly Stop[] = [
  { key: 'play', label: 'Play', sub: 'You and three bots', angle: 0, mode: 'singlePlayer' },
  { key: 'watch', label: 'Watch', sub: 'Four bots', angle: 90, mode: 'spectator' },
  {
    key: 'multi',
    label: 'Multiplayer',
    sub: 'Opens the hosted tables',
    angle: 180,
    href: HOSTED_TABLES_URL,
  },
  { key: 'batch', label: 'Batch', sub: 'Many games at once', angle: 270, to: '/batch' },
];

const angleFor = (mode: StartGameMode): number =>
  STOPS.find((stop) => stop.mode === mode)?.angle ?? 0;

const plate = ref(-angleFor(props.modelValue));
const rings = ref<[number, number, number]>([0, 0, 0]);
const needle = ref(0);
const held = ref<number | null>(null);
let leaveTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.modelValue,
  (mode) => {
    plate.value = plateTarget(plate.value, angleFor(mode));
    rings.value = [
      ringLanding(rings.value[0], 1),
      ringLanding(rings.value[1], -1),
      ringLanding(rings.value[2], 1),
    ];
    pointNeedle(0);
  },
);

/** Where a stop is now on the face, after the plate's turn. */
const faceAngle = (stop: Stop): number => wrap(stop.angle + plate.value);

function pointNeedle(angle: number): void {
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
onBeforeUnmount(cancelLeave);

const face = ref<HTMLElement | null>(null);
function onFaceMove(event: PointerEvent): void {
  if (event.pointerType === 'touch' || face.value === null) return;
  if ((event.target as HTMLElement).closest('.stop')) return;
  const box = face.value.getBoundingClientRect();
  const dx = event.clientX - (box.left + box.width / 2);
  const dy = event.clientY - (box.top + box.height / 2);
  if (Math.hypot(dx, dy) > box.width / 2) return;
  cancelLeave();
  const lean = needleLean(bearing(dx, dy), STOPS.map(faceAngle), held.value);
  held.value = lean.held;
  pointNeedle(lean.angle);
}
function onFaceLeave(): void {
  softLeave();
}

function pick(stop: Stop): void {
  if (stop.mode === undefined || props.disabled === true) return;
  emit('update:modelValue', stop.mode);
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

const plateStyle = computed(() => ({ transform: `rotate(${plate.value}deg)` }));
const ringStyle = (i: 0 | 1 | 2) => ({ transform: `rotate(${rings.value[i]}deg)` });
const needleStyle = computed(() => ({ transform: `rotate(${needle.value}deg)` }));
/** A stop sits on the plate at its own angle, and turns back against the plate to stay upright. */
const R = 44;
const stopStyle = (stop: Stop) => {
  const radians = (stop.angle * Math.PI) / 180;
  return {
    left: `${50 + R * Math.sin(radians)}%`,
    top: `${50 - R * Math.cos(radians)}%`,
    transform: `translate(-50%, -50%) rotate(${-plate.value}deg)`,
  };
};

/** Graduation ticks on the bezel: every 5°, longer every 30°. */
const TICKS = Array.from({ length: 72 }, (_, i) => ({ a: i * 5, major: i % 6 === 0 }));
const RING_TICKS = Array.from({ length: 24 }, (_, i) => i * 15);
</script>

<template>
  <div
    ref="face"
    class="compass"
    role="group"
    aria-label="Mode"
    @pointermove="onFaceMove"
    @pointerleave="onFaceLeave"
    @keydown="onKey"
  >
    <svg class="face" viewBox="-200 -200 400 400" aria-hidden="true">
      <circle r="196" class="bezel" />
      <circle r="178" class="hair" />
      <line
        v-for="t in TICKS"
        :key="t.a"
        :y1="-196"
        :y2="t.major ? -182 : -189"
        :transform="`rotate(${t.a})`"
        class="tick"
      />
      <g class="drift slow">
        <circle r="168" class="dash" />
      </g>
      <g class="ring" :style="ringStyle(0)">
        <circle r="150" class="hair" />
        <path
          v-for="q in [0, 90, 180, 270]"
          :key="q"
          d="M0 -158 L5 -150 L0 -142 L-5 -150 Z"
          :transform="`rotate(${q})`"
          class="ink"
        />
      </g>
      <g class="ring" :style="ringStyle(1)">
        <circle r="124" class="hair" />
        <line
          v-for="a in RING_TICKS"
          :key="a"
          y1="-124"
          :y2="a % 90 === 0 ? -110 : -118"
          :transform="`rotate(${a})`"
          class="tick"
        />
      </g>
      <g class="ring" :style="ringStyle(2)">
        <circle r="96" class="dots" />
      </g>
      <g class="drift fast">
        <circle cx="0" cy="-168" r="3.5" class="warm" />
        <circle cx="0" cy="-168" r="7" class="warm-line" />
      </g>
      <g class="rose">
        <path
          v-for="q in [45, 135, 225, 315]"
          :key="q"
          d="M0 -62 L9 0 L0 9 L-9 0 Z"
          :transform="`rotate(${q})`"
          class="petal-soft"
        />
        <path
          v-for="q in [0, 90, 180, 270]"
          :key="q"
          d="M0 -86 L12 0 L0 12 L-12 0 Z"
          :transform="`rotate(${q})`"
          class="petal"
        />
        <text y="-94" class="north">N</text>
      </g>
      <g class="needle" :style="needleStyle">
        <path d="M0 -132 L7 0 L-7 0 Z" class="ink" />
        <path d="M0 64 L7 0 L-7 0 Z" class="needle-tail" />
        <circle r="9" class="warm" />
        <circle r="3" class="paper" />
      </g>
    </svg>

    <div class="plate" :style="plateStyle">
      <template v-for="(stop, i) in STOPS" :key="stop.key">
        <button
          v-if="stop.mode"
          type="button"
          class="stop"
          :data-stop="stop.key"
          :style="[stopStyle(stop), { animationDelay: `${0.15 + i * 0.08}s` }]"
          :aria-pressed="modelValue === stop.mode"
          :disabled="disabled"
          @click="pick(stop)"
          @mouseenter="hoverStop(stop)"
          @mouseleave="softLeave"
          @focus="hoverStop(stop)"
          @blur="softLeave"
        >
          <span class="label">{{ stop.label }}</span>
          <span class="sub">{{ stop.sub }}</span>
        </button>
        <RouterLink
          v-else-if="stop.to"
          :to="stop.to"
          class="stop"
          :data-stop="stop.key"
          :style="[stopStyle(stop), { animationDelay: `${0.15 + i * 0.08}s` }]"
          @mouseenter="hoverStop(stop)"
          @mouseleave="softLeave"
          @focus="hoverStop(stop)"
          @blur="softLeave"
        >
          <span class="label">{{ stop.label }}</span>
          <span class="sub">{{ stop.sub }}</span>
        </RouterLink>
        <a
          v-else
          :href="stop.href"
          target="_blank"
          rel="noopener"
          class="stop"
          :data-stop="stop.key"
          :style="[stopStyle(stop), { animationDelay: `${0.15 + i * 0.08}s` }]"
          @mouseenter="hoverStop(stop)"
          @mouseleave="softLeave"
          @focus="hoverStop(stop)"
          @blur="softLeave"
        >
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
  width: min(100%, 27rem);
  aspect-ratio: 1 / 1;
  margin: 0 auto;
  user-select: none;
}
.face {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  animation: compassIn 0.9s var(--ease) both;
}
.bezel {
  fill: var(--paper);
  stroke: var(--ink);
  stroke-width: 1;
}
.hair {
  fill: none;
  stroke: var(--ink);
  stroke-width: 0.6;
}
.dash {
  fill: none;
  stroke: var(--rule);
  stroke-width: 1;
  stroke-dasharray: 2 6;
}
.dots {
  fill: none;
  stroke: var(--ink);
  stroke-width: 1.2;
  stroke-dasharray: 0.5 7;
  stroke-linecap: round;
}
.tick {
  stroke: var(--ink);
  stroke-width: 0.8;
}
.ink {
  fill: var(--ink);
}
.paper {
  fill: var(--paper);
}
.warm {
  fill: var(--warm);
}
.warm-line {
  fill: none;
  stroke: var(--warm);
  stroke-width: 0.6;
}
.petal {
  fill: var(--paper-2);
  stroke: var(--ink);
  stroke-width: 0.8;
}
.petal-soft {
  fill: var(--paper);
  stroke: var(--rule);
  stroke-width: 0.8;
}
.north {
  fill: var(--muted);
  font-family: var(--font-display);
  font-size: 13px;
  text-anchor: middle;
}
.needle-tail {
  fill: var(--paper);
  stroke: var(--ink);
  stroke-width: 0.8;
}
.ring,
.needle,
.drift {
  transform-box: view-box;
  transform-origin: 0 0;
}
.ring {
  transition: transform 1.6s var(--ease);
}
.needle {
  transition: transform 0.45s cubic-bezier(0.34, 1.45, 0.64, 1);
}
.drift.slow {
  animation: compassDrift 240s linear infinite;
}
.drift.fast {
  animation: compassDrift 70s linear infinite;
}
.rose {
  animation: compassRose 0.9s var(--ease) 0.15s both;
  transform-box: view-box;
  transform-origin: 0 0;
}
.plate {
  position: absolute;
  inset: 0;
  transition: transform 1s var(--ease);
}
.stop {
  position: absolute;
  left: 50%;
  top: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.1rem;
  min-width: 6.4rem;
  min-height: 44px;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  text-decoration: none;
  transition:
    transform 1s var(--ease),
    background-color 0.3s var(--ease),
    color 0.3s var(--ease),
    box-shadow 0.3s var(--ease);
}
.stop:hover:not(:disabled) {
  background: var(--paper);
  box-shadow: inset 0 0 0 1px var(--ink);
}
.stop[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
  box-shadow:
    inset 0 0 0 3px var(--ink),
    inset 0 0 0 4px var(--paper);
}
.stop[aria-pressed='true']:hover:not(:disabled) {
  background: var(--ink-soft);
}
.label {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  white-space: nowrap;
}
.sub {
  font-family: var(--font-body);
  font-size: 0.62rem;
  white-space: nowrap;
  color: var(--muted);
}
.stop[aria-pressed='true'] .sub {
  color: var(--paper);
  opacity: 0.85;
}
.ext {
  font-size: 0.8em;
}
@keyframes compassIn {
  from {
    opacity: 0;
    transform: scale(0.94);
  }
  to {
    opacity: 1;
    transform: none;
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
@keyframes compassDrift {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
:global(.reduced-motion) .drift {
  animation: none !important;
}
@media (prefers-reduced-motion: reduce) {
  .drift,
  .rose,
  .face {
    animation: none;
  }
  .ring,
  .needle,
  .plate,
  .stop {
    transition: none;
  }
}
@media (max-width: 520px) {
  .stop {
    min-width: 5.2rem;
    padding: 0.3rem 0.45rem;
  }
  .sub {
    display: none;
  }
}
</style>
