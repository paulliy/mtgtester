<script setup lang="ts">
/**
 * The one confirmation shown before a game is abandoned, in spectator and player mode alike.
 * Cancel takes focus, so Enter or an accidental second click never confirms; Escape cancels.
 */
import { onMounted, ref } from 'vue';

defineProps<{ message: string }>();
const emit = defineEmits<{
  (event: 'confirm'): void;
  (event: 'cancel'): void;
}>();

const cancelButton = ref<HTMLButtonElement | null>(null);
onMounted(() => cancelButton.value?.focus());
</script>

<template>
  <div class="modal-backdrop" @keydown.esc="emit('cancel')">
    <div
      class="modal-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="abandon-title"
      aria-describedby="abandon-message"
    >
      <h3 id="abandon-title">Abandon match?</h3>
      <p id="abandon-message">{{ message }}</p>
      <div class="modal-actions">
        <button ref="cancelButton" type="button" class="cancel-btn" @click="emit('cancel')">
          Cancel
        </button>
        <button type="button" class="confirm-danger-btn" @click="emit('confirm')">
          Confirm Abandon
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
