<script setup lang="ts">
/** Day / Night / Match system (ADR 0052 decision 3), in the top bar and the phone menu. */
import { THEME_CHOICES, useThemeStore, type ThemeChoice } from '../../stores/theme';

const theme = useThemeStore();
const LABELS: Record<ThemeChoice, string> = {
  day: 'Day',
  night: 'Night',
  system: 'Match system',
};
</script>

<template>
  <div class="theme-control" role="group" aria-label="Theme">
    <button
      v-for="choice in THEME_CHOICES"
      :key="choice"
      type="button"
      :aria-pressed="theme.choice === choice"
      @click="theme.setChoice(choice)"
    >
      {{ LABELS[choice] }}
    </button>
  </div>
</template>

<style scoped>
.theme-control {
  display: inline-flex;
  flex-shrink: 0;
  padding-left: 1px;
}
.theme-control button {
  margin-left: -1px;
  min-height: 28px;
  padding: 0 0.5rem;
  font-family: var(--font-ui);
  font-size: 0.6rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}
.theme-control button[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
</style>
