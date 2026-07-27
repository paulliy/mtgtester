<script setup lang="ts">
/**
 * The timeline scrubber and playback controls (brief §10.1).
 *
 * The scrubber's maximum is the compute frontier, never past it: "you can scrub freely
 * backward, never forward past what has been computed." Moving it forward is also what lets
 * the server compute further — it computes at most five turns beyond this position — so the
 * control is not merely a viewer, it is the throttle.
 */
import { computed, ref } from 'vue';
import type { PlaybackMode } from '@mtg/shared';

const props = defineProps<{
  viewTurn: number;
  frontierTurn: number;
  mode: PlaybackMode;
  waiting: boolean;
  isRunning?: boolean;
}>();

const emit = defineEmits<{
  (event: 'jump', turn: number): void;
  (event: 'back'): void;
  (event: 'forward'): void;
  (event: 'stepAction', delta: number): void;
  (event: 'mode', mode: PlaybackMode): void;
  (event: 'abandon'): void;
}>();

const showAbandonModal = ref(false);

const canBack = computed(() => props.viewTurn > 0);
const canForward = computed(
  () => props.viewTurn < props.frontierTurn || (props.isRunning ?? false),
);

function onScrub(event: Event): void {
  emit('jump', Number((event.target as HTMLInputElement).value));
}

function confirmAbandon(): void {
  showAbandonModal.value = false;
  emit('abandon');
}

const currentRound = computed(() =>
  props.viewTurn > 0 ? Math.floor((props.viewTurn - 1) / 4) + 1 : 0,
);
</script>

<template>
  <div class="controls">
    <div class="row main-row">
      <button type="button" class="nav-btn" :disabled="!canBack" @click="emit('back')">◀ Turn</button>
      <button type="button" class="nav-btn action-step-btn" :disabled="!canBack" @click="emit('stepAction', -1)" title="Step back 1 action">◀ Action</button>
      <input
        class="scrubber"
        type="range"
        min="0"
        :max="Math.max(frontierTurn + (isRunning ? 1 : 0), 1)"
        :value="viewTurn"
        @input="onScrub"
      />
      <button type="button" class="nav-btn action-step-btn" :disabled="!canForward" @click="emit('stepAction', 1)" title="Step forward 1 action">Action ▶</button>
      <button type="button" class="nav-btn" :disabled="!canForward" @click="emit('forward')">Turn ▶</button>
      <span class="position">
        Round <strong>{{ currentRound }}</strong> (Turn {{ viewTurn }}/{{ frontierTurn }})
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

      <span v-if="waiting" class="waiting">
        ⏸ Paused — engine is 5 turns ahead; step forward to compute more
      </span>

      <button type="button" class="danger-btn" @click="showAbandonModal = true">
        Abandon Game
      </button>
    </div>

    <!-- Confirmation Modal -->
    <div v-if="showAbandonModal" class="modal-backdrop">
      <div class="modal-card">
        <h3>Abandon Match?</h3>
        <p>Are you sure you want to terminate the current game session?</p>
        <div class="modal-actions">
          <button type="button" class="cancel-btn" @click="showAbandonModal = false">Cancel</button>
          <button type="button" class="confirm-danger-btn" @click="confirmAbandon">Confirm Abandon</button>
        </div>
      </div>
    </div>
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
  background: rgb(0 0 0 / 0.25);
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
  color: #101828;
  font-weight: 700;
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

/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.75);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 1.2rem 1.5rem;
  max-width: 22rem;
  width: 90%;
  box-shadow: 0 10px 25px rgb(0 0 0 / 0.5);
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.modal-card h3 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--danger);
}
.modal-card p {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text);
  line-height: 1.4;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 0.4rem;
}
.cancel-btn {
  background: var(--surface-2);
  border: 1px solid var(--line);
  color: var(--text);
}
.confirm-danger-btn {
  background: var(--danger);
  border: 1px solid var(--danger);
  color: #fff;
  font-weight: 700;
}
</style>
