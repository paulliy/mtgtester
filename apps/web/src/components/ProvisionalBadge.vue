<script setup lang="ts">
/**
 * The mark on a provisional card (H1): it plays by a machine-checked patch from the review queue
 * that nobody has reviewed yet, so a game it appears in is not fully reviewed evidence.
 */
</script>

<template>
  <span
    class="provisional-badge"
    role="img"
    aria-label="Provisional card: rules machine-checked, not yet reviewed"
    title="Provisional: this card's rules were machine-checked but not yet reviewed by a person"
    data-testid="provisional-badge"
    >P</span
  >
</template>

<style scoped>
.provisional-badge {
  position: absolute;
  top: 3px;
  left: 3px;
  z-index: 11;
  min-width: 1.1em;
  padding: 0.05rem 0.25rem;
  border-radius: 999px;
  background: var(--warn);
  color: var(--paper);
  border: 1px solid rgb(0 0 0 / 0.5);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.5);
  font-size: 0.6rem;
  font-weight: 800;
  line-height: 1.2;
  text-align: center;
  pointer-events: auto;
}
</style>
