<script setup lang="ts">
/**
 * A color identity as mana-symbol circles, in WUBRG order, or C for colorless. The setup screen's
 * counterpart to `DeckColors`, which reads the same thing off a live board's commanders.
 */
import { computed } from 'vue';

const props = defineProps<{ colors: readonly string[] }>();

const NAMES: Record<string, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
};

const ordered = computed(() => ['W', 'U', 'B', 'R', 'G'].filter((c) => props.colors.includes(c)));
const label = computed(
  () => `Colors: ${ordered.value.map((c) => NAMES[c]).join(', ') || 'Colorless'}`,
);
</script>

<template>
  <span class="mana-pips" role="img" :aria-label="label" :title="label">
    <span v-for="c in ordered" :key="c" class="mana" :class="`mana-${c}`">{{ c }}</span>
    <span v-if="ordered.length === 0" class="mana mana-C">C</span>
  </span>
</template>

<style scoped>
.mana-pips {
  display: inline-flex;
  gap: 3px;
  flex-shrink: 0;
}
.mana {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 800;
  color: #1c1917;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.35);
}
.mana-W {
  background: #f8f4d8;
}
.mana-U {
  background: #a9cdf0;
}
.mana-B {
  background: #b5aaa6;
}
.mana-R {
  background: #f0a184;
}
.mana-G {
  background: #9bcb98;
}
.mana-C {
  background: #d6d3d1;
}
</style>
