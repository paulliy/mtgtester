<script setup lang="ts">
/**
 * The timeline scrubber and playback controls (brief §10.1).
 *
 * The scrubber's maximum is the compute frontier, never past it: "you can scrub freely
 * backward, never forward past what has been computed." Moving it forward is also what lets
 * the server compute further — it computes at most five turns beyond this position — so the
 * control is not merely a viewer, it is the throttle.
 */
import { computed, ref, watch } from 'vue';
import type { PlaybackMode } from '@mtg/shared';
import ConfirmAbandonDialog from './ConfirmAbandonDialog.vue';

const props = defineProps<{
  viewTurn: number;
  frontierTurn: number;
  mode: PlaybackMode;
  waiting: boolean;
  isRunning?: boolean;
  /** Seats in the game, for turns → rounds. Four in v1, but never assume it here. */
  seatCount?: number | undefined;
  paceMs?: number;
  /** Whether an action step is available in each direction — asked of the log, not the turn. */
  canStepBackAction?: boolean;
  canStepForwardAction?: boolean;
}>();

const emit = defineEmits<{
  (event: 'jump', turn: number): void;
  (event: 'back'): void;
  (event: 'forward'): void;
  (event: 'stepAction', delta: number): void;
  (event: 'mode', mode: PlaybackMode): void;
  (event: 'pace', ms: number): void;
  (event: 'abandon'): void;
}>();

const showAbandonModal = ref(false);

const canBack = computed(() => props.viewTurn > 0);
const canForward = computed(
  () => props.viewTurn < props.frontierTurn || (props.isRunning ?? false),
);

/**
 * The scrubber's own value while the user is dragging it.
 *
 * A range input fires `input` for every pixel of travel. Emitting a jump per event asked the
 * server for a full board — 10–20 KB each — dozens of times per drag, and every reply reset the
 * thumb under the user's finger. The thumb now follows the pointer locally and only the
 * position it settles on is requested.
 */
const dragTurn = ref<number | null>(null);
const scrubValue = computed(() => dragTurn.value ?? props.viewTurn);

// A jump the user did not initiate (live presentation, a log click) must move the thumb.
watch(
  () => props.viewTurn,
  () => {
    if (dragTurn.value === null) return;
    dragTurn.value = null;
  },
);

function onScrubInput(event: Event): void {
  dragTurn.value = Number((event.target as HTMLInputElement).value);
}

function onScrubCommit(event: Event): void {
  const turn = Number((event.target as HTMLInputElement).value);
  dragTurn.value = null;
  if (turn !== props.viewTurn) emit('jump', turn);
}

function confirmAbandon(): void {
  showAbandonModal.value = false;
  emit('abandon');
}

/** Turn → round. Uses the real seat count; a 4 hardcoded here disagreed with the board header. */
const currentRound = computed(() => {
  const seats = props.seatCount !== undefined && props.seatCount > 0 ? props.seatCount : 4;
  return props.viewTurn > 0 ? Math.floor((props.viewTurn - 1) / seats) + 1 : 0;
});

const SPEEDS: Array<{ label: string; ms: number }> = [
  { label: '1×', ms: 1_200 },
  { label: '2×', ms: 600 },
  { label: '4×', ms: 300 },
  { label: 'Max', ms: 0 },
];
</script>

<template>
  <div class="controls">
    <div class="row main-row">
      <button type="button" class="nav-btn" :disabled="!canBack" @click="emit('back')">
        ◀ Turn
      </button>
      <button
        type="button"
        class="nav-btn action-step-btn"
        :disabled="canStepBackAction === false"
        title="Step back 1 action"
        @click="emit('stepAction', -1)"
      >
        ◀ Action
      </button>
      <input
        class="scrubber"
        type="range"
        min="0"
        :max="Math.max(frontierTurn, 1)"
        :value="scrubValue"
        @input="onScrubInput"
        @change="onScrubCommit"
      />
      <button
        type="button"
        class="nav-btn action-step-btn"
        :disabled="canStepForwardAction === false"
        title="Step forward 1 action"
        @click="emit('stepAction', 1)"
      >
        Action ▶
      </button>
      <button type="button" class="nav-btn" :disabled="!canForward" @click="emit('forward')">
        Turn ▶
      </button>
      <span class="position">
        Round <strong>{{ currentRound }}</strong> (Turn {{ scrubValue }}/{{ frontierTurn }})
      </span>
    </div>

    <div class="row mode-row">
      <div class="mode-toggles">
        <label :class="{ active: mode === 'live' }">
          <input
            type="radio"
            value="live"
            :checked="mode === 'live'"
            @change="emit('mode', 'live')"
          />
          Live
        </label>
        <label :class="{ active: mode === 'manual' }">
          <input
            type="radio"
            value="manual"
            :checked="mode === 'manual'"
            @change="emit('mode', 'manual')"
          />
          Manual
        </label>
      </div>

      <div class="mode-toggles speed-toggles" :class="{ dim: mode !== 'live' }">
        <span class="speed-label">Speed</span>
        <label v-for="speed in SPEEDS" :key="speed.label" :class="{ active: paceMs === speed.ms }">
          <input
            type="radio"
            :value="speed.ms"
            :checked="paceMs === speed.ms"
            @change="emit('pace', speed.ms)"
          />
          {{ speed.label }}
        </label>
      </div>

      <span v-if="waiting" class="waiting">
        ⏸ Paused — the engine is as far ahead as it may compute; step forward for more
      </span>

      <button type="button" class="danger-btn" @click="showAbandonModal = true">
        Abandon Game
      </button>
    </div>

    <ConfirmAbandonDialog
      v-if="showAbandonModal"
      message="Are you sure you want to terminate the current game session?"
      @cancel="showAbandonModal = false"
      @confirm="confirmAbandon"
    />
  </div>
</template>

<style scoped>
.controls {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  padding: 0.6rem 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  box-shadow: 0 -2px 10px rgb(0 0 0 / 0.2);
}
.row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  font-size: 0.8rem;
}
.scrubber {
  flex: 1;
  accent-color: var(--accent);
  cursor: pointer;
}
.nav-btn {
  font-weight: 700;
  padding: 0.3rem 0.6rem;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 4px;
}
.action-step-btn {
  color: var(--accent);
  border-color: rgb(96 165 250 / 0.3);
  font-size: 0.75rem;
  padding: 0.3rem 0.5rem;
}
.action-step-btn:hover:not(:disabled) {
  background: rgb(96 165 250 / 0.15);
  border-color: var(--accent);
}
.position {
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-size: 0.8rem;
  background: var(--surface-2);
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
}
.position strong {
  color: var(--text);
}
.mode-toggles {
  display: flex;
  gap: 0.4rem;
  background: var(--surface-2);
  padding: 0.15rem;
  border-radius: 4px;
  border: 1px solid var(--line);
}
.mode-toggles label {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
  padding: 0.2rem 0.5rem;
  border-radius: 3px;
  font-size: 0.78rem;
  color: var(--muted);
}
.mode-toggles label.active {
  background: var(--accent);
  color: var(--surface);
  font-weight: 700;
}
.speed-toggles {
  gap: 0.2rem;
}
.speed-toggles.dim {
  opacity: 0.5;
}
.speed-label {
  align-self: center;
  padding: 0 0.3rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
/* The radios themselves are redundant with the highlighted label; keep them for a11y only. */
.mode-toggles input[type='radio'] {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.mode-toggles label {
  position: relative;
}
.waiting {
  flex: 1;
  color: var(--warn);
  font-size: 0.75rem;
  font-weight: 600;
}
.danger-btn {
  margin-left: auto;
  border: 1px solid rgb(226 104 95 / 0.4);
  color: var(--danger);
  background: rgb(226 104 95 / 0.08);
  font-weight: 600;
  padding: 0.3rem 0.7rem;
  border-radius: 4px;
  transition: all 120ms ease;
}
.danger-btn:hover {
  background: var(--danger);
  color: #fff;
}
</style>
