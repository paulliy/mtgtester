<script setup lang="ts">
/**
 * The table app's shell (ADR 0031, plan M6; Decktank redesign phase 8): the brand and its
 * "Tables" mark, the top-bar slot the player board teleports its status into, the theme control,
 * the router view and the card preview. None of the tester's navigation.
 */
import { RouterLink, RouterView } from 'vue-router';
import CardPreviewOverlay from '../components/CardPreviewOverlay.vue';
import ThemeControl from '../components/shell/ThemeControl.vue';
import { useGameStore } from '../stores/game';

const game = useGameStore();
</script>

<template>
  <div class="app table-app" :class="{ 'reduced-motion': game.reducedMotion }">
    <header class="topbar">
      <RouterLink to="/" class="brand" aria-label="Decktank tables">
        <span class="name">Decktank</span>
        <span class="mark" aria-hidden="true">Tables</span>
      </RouterLink>
      <div id="top-bar-status" class="status-slot" />
      <ThemeControl class="topbar-theme" />
    </header>
    <main class="view">
      <RouterView />
    </main>
    <CardPreviewOverlay />
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
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
  align-items: center;
  gap: 0.4rem 1.5rem;
  min-height: 3.4rem;
  padding: 0 1.25rem;
  border-bottom: 1px solid var(--ink);
  background: var(--paper);
  flex-shrink: 0;
  animation: dtFade 0.6s var(--ease) both;
}
.brand {
  display: inline-flex;
  align-items: baseline;
  gap: 0.6rem;
  flex-shrink: 0;
  padding: 0.55rem 0;
  text-decoration: none;
  color: var(--ink);
}
.brand .name {
  font-family: var(--font-display);
  font-size: 1.3rem;
  line-height: 1;
  letter-spacing: -0.03em;
  text-transform: uppercase;
}
.brand .mark {
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--ink);
  font-family: var(--font-ui);
  font-size: 0.58rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.status-slot {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  min-width: 0;
  font-size: 0.8rem;
}
@media (max-width: 760px) {
  .topbar {
    padding: 0 1rem;
    gap: 0.3rem 0.75rem;
  }
  .topbar-theme {
    margin-left: auto;
  }
}
</style>
