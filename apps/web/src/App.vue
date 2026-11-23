<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import CardPreviewOverlay from './components/CardPreviewOverlay.vue';
import { useCardPreviewStore } from './stores/cardPreview';
import { useGameStore } from './stores/game';
import { THEME_CHOICES, useThemeStore, type ThemeChoice } from './stores/theme';

const cardPreview = useCardPreviewStore();
const game = useGameStore();
const route = useRoute();
const showCardTestLab = import.meta.env['DEV'] === true;
const theme = useThemeStore();
const THEME_LABELS: Record<ThemeChoice, string> = {
  day: 'Day',
  night: 'Night',
  system: 'Match system',
};

/**
 * Alt held while hovering a card = the "look closer" zoom. `window.blur` covers Alt-tabbing
 * away mid-hover, which leaves no `keyup` event and would otherwise stick the zoom on.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Alt') cardPreview.setAltHeld(true);
}
function onKeyUp(event: KeyboardEvent): void {
  if (event.key === 'Alt') cardPreview.setAltHeld(false);
}
function onBlur(): void {
  cardPreview.setAltHeld(false);
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', onBlur);
});
</script>

<template>
  <div class="app" :class="{ 'reduced-motion': game.reducedMotion }">
    <nav>
      <RouterLink to="/">Setup</RouterLink>
      <RouterLink to="/game">Board</RouterLink>
      <RouterLink to="/stats">Stats</RouterLink>
      <RouterLink to="/debug">Debug</RouterLink>
      <RouterLink to="/batch">Batch</RouterLink>
      <RouterLink v-if="showCardTestLab" to="/card-test-lab">Card Test Lab</RouterLink>
      <RouterLink v-if="showCardTestLab" to="/deals-preview">Deals</RouterLink>
      <!-- The board view fills this with the game's status (round, phase, priority) via a
           Teleport, so the board itself keeps the space a second header bar would take. -->
      <div id="top-bar-status" class="status-slot" />
      <span v-if="route.name !== 'game'" class="brand">Decktank</span>
      <div class="theme" role="group" aria-label="Theme">
        <button
          v-for="choice in THEME_CHOICES"
          :key="choice"
          type="button"
          :aria-pressed="theme.choice === choice"
          @click="theme.setChoice(choice)"
        >
          {{ THEME_LABELS[choice] }}
        </button>
      </div>
    </nav>
    <main class="view">
      <RouterView />
    </main>
    <CardPreviewOverlay />
  </div>
</template>

<style scoped>
/*
 * A column, not just a min-height: the board view fills the space the nav leaves rather than
 * claiming a viewport of its own. It used to be `min-height: 100vh` here over a `height: 100vh`
 * child, which is one nav bar taller than the window — the playback controls sat below the fold
 * and were sliced in half, with the whole page scrolling to compensate.
 */
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* The routed view owns what is left. It scrolls itself — the board fills it exactly, the setup
   form is free to be longer than the window. */
.view {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  padding: 0.4rem 0.8rem;
  border-bottom: 1px solid var(--line);
  font-size: 0.8rem;
  flex-shrink: 0;
}
nav a {
  color: var(--muted);
  text-decoration: none;
}
nav a.router-link-active {
  color: var(--text);
  font-weight: 600;
}
.status-slot {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  min-width: 0;
}
.status-slot:empty {
  display: none;
}
.brand {
  margin-left: auto;
  font-family: var(--font-display);
  font-size: 1.05rem;
  letter-spacing: -0.02em;
  text-transform: uppercase;
  color: var(--ink);
}
/* Day / Night / Match system (ADR 0052). Phase 2 of the redesign moves it into the ruler nav. */
.theme {
  display: inline-flex;
  flex-shrink: 0;
}
.theme button {
  margin-left: -1px;
  padding: 0.15rem 0.5rem;
  font-family: var(--font-ui);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.theme button[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
</style>
