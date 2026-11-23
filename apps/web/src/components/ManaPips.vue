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
  font-family: var(--font-display);
  font-weight: 400;
  line-height: 1;
  color: var(--mana-letter);
  box-shadow: inset 0 0 0 1px var(--ink);
}
.mana-W {
  background: var(--mana-w);
}
.mana-U {
  background: var(--mana-u);
}
.mana-B {
  background: var(--mana-b);
  color: var(--mana-b-letter);
}
.mana-R {
  background: var(--mana-r);
}
.mana-G {
  background: var(--mana-g);
}
.mana-C {
  background: var(--mana-c);
}
</style>
