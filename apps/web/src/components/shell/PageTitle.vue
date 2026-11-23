<script setup lang="ts">
/**
 * A Records or Workshop page's title (redesign plan, phase 7): where the page sits ("II. Records
 * · a. Stats") in small capitals, the title in Bodoni capitals, and the star-and-rule ornament.
 * The heading level stays `h1` (or `h2` where a page already used one), so every test that finds
 * a page by its heading still does.
 */
defineProps<{ place: string; level?: 1 | 2 }>();
</script>

<template>
  <div class="page-title dt-rise">
    <p class="dt-kicker">{{ place }}</p>
    <component :is="level === 2 ? 'h2' : 'h1'" class="dt-title"><slot /></component>
    <div class="dt-ornament" aria-hidden="true"><span class="star" /></div>
  </div>
</template>

<style scoped>
.page-title {
  display: grid;
  gap: 0.65rem;
  min-width: 0;
}
.page-title .dt-kicker {
  margin: 0;
}
.page-title .dt-title {
  font-size: clamp(2rem, 3.6vw, 3.2rem);
}
</style>
