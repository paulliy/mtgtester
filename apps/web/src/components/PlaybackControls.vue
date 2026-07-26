<script setup lang="ts">
/**
 * The timeline scrubber and playback controls (brief §10.1).
 *
 * The scrubber's maximum is the compute frontier, never past it: "you can scrub freely
 * backward, never forward past what has been computed." Moving it forward is also what lets
 * the server compute further — it computes at most five turns beyond this position — so the
 * control is not merely a viewer, it is the throttle.
 */
import { computed } from 'vue';
import type { PlaybackMode } from '@mtg/shared';

const props = defineProps<{
  viewTurn: number;
  frontierTurn: number;
  mode: PlaybackMode;
  waiting: boolean;
}>();

const emit = defineEmits<{
  (event: 'jump', turn: number): void;
  (event: 'back'): void;
  (event: 'forward'): void;
  (event: 'mode', mode: PlaybackMode): void;
  (event: 'abandon'): void;
}>();

const canBack = computed(() => props.viewTurn > 0);
const canForward = computed(() => props.viewTurn < props.frontierTurn);

function onScrub(event: Event): void {
  emit('jump', Number((event.target as HTMLInputElement).value));
}
</script>

<template>
  <div class="controls">
    <div class="row">
      <button type="button" :disabled="!canBack" @click="emit('back')">◀ turn</button>
      <input
        class="scrubber"
        type="range"
        min="0"
        :max="Math.max(frontierTurn, 1)"
        :value="viewTurn"
        @input="onScrub"
      />
      <button type="button" :disabled="!canForward" @click="emit('forward')">turn ▶</button>
      <span class="position">
        turn <strong>{{ viewTurn }}</strong> / computed {{ frontierTurn }}
      </span>
    </div>

    <div class="row">
      <label>
        <input
          type="radio"
          value="live"
          :checked="mode === 'live'"
          @change="emit('mode', 'live')"
        />
        live
      </label>
      <label>
        <input
          type="radio"
          value="manual"
          :checked="mode === 'manual'"
          @change="emit('mode', 'manual')"
        />
        manual
      </label>
      <span v-if="waiting" class="waiting">
        paused — compute is 5 turns ahead of you; step forward to continue
      </span>
      <button type="button" class="danger" @click="emit('abandon')">abandon</button>
    </div>
  </div>
</template>

<style scoped>
.controls {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  padding: 0.5rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.78rem;
}
.scrubber {
  flex: 1;
}
.position {
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
label {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
}
.waiting {
  flex: 1;
  color: var(--warn);
}
button.danger {
  margin-left: auto;
  border-color: var(--danger);
  color: var(--danger);
}
</style>
