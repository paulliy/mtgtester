<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import CardPreviewOverlay from './components/CardPreviewOverlay.vue';
import PhoneMenu from './components/shell/PhoneMenu.vue';
import RulerNav from './components/shell/RulerNav.vue';
import ThemeControl from './components/shell/ThemeControl.vue';
import { currentPlaceIndex, navPlaces } from './lib/navigation';
import { useCardPreviewStore } from './stores/cardPreview';
import { useGameStore } from './stores/game';

const cardPreview = useCardPreviewStore();
const game = useGameStore();
const route = useRoute();

/** The ruler's places: dev-only ones in a dev build, and the way back while a game runs. */
const places = computed(() =>
  navPlaces({ dev: import.meta.env['DEV'] === true, gameRunning: game.gameId !== null }),
);
const current = computed(() =>
  currentPlaceIndex(places.value, typeof route.name === 'string' ? route.name : null),
);

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
    <header class="topbar">
      <RouterLink to="/" class="brand">Decktank</RouterLink>
      <PhoneMenu :places="places" :current="current" />
      <!-- The board view fills this with the game's status (round, phase, priority) via a
           Teleport, so the board itself keeps the space a second header bar would take. -->
      <div id="top-bar-status" class="status-slot" />
      <RulerNav :places="places" :current="current" />
      <ThemeControl class="topbar-theme" />
    </header>
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
.topbar {
  position: relative;
  z-index: 40;
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 0 1.5rem;
  padding: 0 1.25rem;
  border-bottom: 1px solid var(--ink);
  background: var(--paper);
  flex-shrink: 0;
}
.brand {
  align-self: center;
  flex-shrink: 0;
  padding: 0.55rem 0;
  font-family: var(--font-display);
  font-size: 1.3rem;
  line-height: 1;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--ink);
}
.status-slot {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  min-width: 0;
  font-size: 0.8rem;
}
/* A game's status (turn, phase ruler, resources) is a second row under the nav, as the board
   header in the Decktank design is, so neither crowds the other. */
.status-slot:not(:empty) {
  order: 10;
  flex: 1 1 100%;
  flex-wrap: wrap;
  row-gap: 0.4rem;
  min-height: 3.4rem;
  margin: 0 -1.25rem;
  padding: 0.35rem 1.25rem;
  border-top: 1px solid var(--rule);
}
.topbar-theme {
  align-self: center;
}
@media (max-width: 760px) {
  .topbar {
    gap: 0 0.75rem;
    padding: 0 1rem;
  }
  .topbar > .brand,
  .topbar > .topbar-theme {
    display: none;
  }
}
</style>
