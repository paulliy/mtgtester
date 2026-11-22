<script setup lang="ts">
/**
 * A deck's colors as mana-symbol circles: its commanders' combined color identity, in WUBRG
 * order, or C for a colorless deck. Renders nothing for a snapshot saved before the board sent
 * color identity.
 */
import { computed } from 'vue';
import type { SpectatorCommander } from '@mtg/shared';

const props = defineProps<{ commanders: readonly SpectatorCommander[] }>();

const NAMES: Record<string, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
};

const known = computed(() => props.commanders.some((c) => c.colorIdentity !== undefined));
const colors = computed(() => {
  const identity = new Set<string>(props.commanders.flatMap((c) => c.colorIdentity ?? []));
  return ['W', 'U', 'B', 'R', 'G'].filter((c) => identity.has(c));
});
const title = computed(
  () => `Deck colors: ${colors.value.map((c) => NAMES[c]).join(', ') || 'Colorless'}`,
);
</script>

<template>
  <span v-if="known" class="deck-colors" :title="title" :aria-label="title">
    <span v-for="c in colors" :key="c" class="mana" :class="`mana-${c}`" aria-hidden="true">{{
      c
    }}</span>
    <span v-if="colors.length === 0" class="mana mana-C" aria-hidden="true">C</span>
  </span>
</template>

<style scoped>
.deck-colors {
  display: inline-flex;
  gap: 2px;
  flex-shrink: 0;
}
/* Colour identity in the muted Decktank colours (ADR 0052 decision 4), ringed in ink. */
.mana {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.5rem;
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
