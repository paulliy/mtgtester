<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import CardPreviewOverlay from './components/CardPreviewOverlay.vue';
import { useCardPreviewStore } from './stores/cardPreview';

const cardPreview = useCardPreviewStore();

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
  <div class="app">
    <nav>
      <RouterLink to="/">Setup</RouterLink>
      <RouterLink to="/game">Board</RouterLink>
      <span class="brand">MTG Commander AI Simulator</span>
    </nav>
    <RouterView />
    <CardPreviewOverlay />
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
}
nav {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.4rem 0.8rem;
  border-bottom: 1px solid var(--line);
  font-size: 0.8rem;
}
nav a {
  color: var(--muted);
  text-decoration: none;
}
nav a.router-link-active {
  color: var(--text);
  font-weight: 600;
}
.brand {
  margin-left: auto;
  color: var(--muted);
}
</style>
