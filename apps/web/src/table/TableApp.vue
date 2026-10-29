<script setup lang="ts">
/**
 * The table app's shell (ADR 0031, plan M6): the router view and the card preview, and the
 * top-bar slot the player board teleports its status into. None of the tester's navigation.
 */
import { RouterView } from 'vue-router';
import CardPreviewOverlay from '../components/CardPreviewOverlay.vue';
import { useGameStore } from '../stores/game';

const game = useGameStore();
</script>

<template>
  <div class="app table-app" :class="{ 'reduced-motion': game.reducedMotion }">
    <nav>
      <span class="brand">MTG Commander tables</span>
      <div id="top-bar-status" class="status-slot" />
    </nav>
    <main class="view">
      <RouterView />
    </main>
    <CardPreviewOverlay />
  </div>
</template>
