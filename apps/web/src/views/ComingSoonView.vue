<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import PageFoot from '../components/shell/PageFoot.vue';
import PageTitle from '../components/shell/PageTitle.vue';

/**
 * Stats and Batch in a local-games build (ADR 0053): both read the server's database of finished
 * games, which a game played in the browser never reaches, so for now the place says so.
 */
const route = useRoute();
const page = computed(() =>
  route.name === 'stats'
    ? {
        place: 'II. Records · a. Stats',
        title: 'Deck statistics',
        text: 'Standings, matchups and how each deck fares across many games.',
      }
    : {
        place: 'II. Records · b. Batch runs',
        title: 'Batch simulations',
        text: 'Run the same table many times over and read the results side by side.',
      },
);
</script>

<template>
  <section class="soon">
    <PageTitle :place="page.place">{{ page.title }}</PageTitle>
    <p class="tag">Coming soon</p>
    <p>{{ page.text }}</p>
    <p>
      Games here run in your browser and are not saved, so there is nothing to count yet.
      <RouterLink to="/">Start a game</RouterLink> in the meantime.
    </p>
    <PageFoot :place="page.place" />
  </section>
</template>

<style scoped>
.soon {
  max-width: 720px;
  margin: 0 auto;
  padding: 1rem;
}
.tag {
  display: inline-block;
  margin: 0.5rem 0 1rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--ink);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
</style>
