<script setup lang="ts">
/** The footer line under a Records or Workshop page: "Decktank · II. Records · a. Stats". */
defineProps<{ place: string }>();
</script>

<template>
  <p class="dt-footline">Decktank · {{ place }}</p>
</template>
