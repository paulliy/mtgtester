<script setup lang="ts">
/**
 * The way back from the multiplayer tables to single player (ADR 0053, plan section 7). Only the
 * site has single player: the tables-only build (`vite build --mode table`) leaves this out.
 */
const onSite = import.meta.env.MODE !== 'table';
</script>

<template>
  <RouterLink v-if="onSite" to="/" class="single-player dt-btn small" data-testid="single-player"
    >Single player<span class="dt-arr" aria-hidden="true"
  /></RouterLink>
</template>

<style scoped>
.single-player {
  justify-self: start;
  align-self: start;
  text-decoration: none;
}
</style>
