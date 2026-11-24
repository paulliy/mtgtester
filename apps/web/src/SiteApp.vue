<script setup lang="ts">
/**
 * The site's root (ADR 0053, plan section 7). Single player's pages sit in the tester's shell,
 * with its ruler of places; the multiplayer tables' pages (`meta.shell` is `table`) sit in their
 * own, which has no navigation, since leaving a table's page closes its connection. Each shell
 * loads on demand.
 */
import { computed, defineAsyncComponent } from 'vue';
import { useRoute } from 'vue-router';

const TesterShell = defineAsyncComponent(() => import('./App.vue'));
const TableShell = defineAsyncComponent(() => import('./table/TableApp.vue'));

const route = useRoute();
const tables = computed(() => route.meta['shell'] === 'table');
</script>

<template>
  <TableShell v-if="tables" />
  <TesterShell v-else />
</template>
