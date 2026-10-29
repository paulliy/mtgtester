<script setup lang="ts">
/**
 * Mana you can make by hand from one permanent (ADR 0030): a button per kind of mana its mana
 * abilities can make, drawn over the bottom-left corner of its tile.
 */
import type { ActionPresentation, LegalAction } from '@mtg/shared';

/**
 * `presentation` is the request's per-action entries: the server writes each button's label and
 * its mana symbols, so nothing here reads `data` or splits the engine's description.
 */
const props = defineProps<{
  actions: readonly LegalAction[];
  presentation?: Record<number, ActionPresentation> | undefined;
}>();
const emit = defineEmits<{ tap: [action: LegalAction] }>();

function entry(action: LegalAction): ActionPresentation | undefined {
  return props.presentation?.[action.id];
}
function symbols(action: LegalAction): string[] {
  return entry(action)?.manaSymbols ?? [];
}
function title(action: LegalAction): string {
  return entry(action)?.label ?? 'Tap for mana';
}
</script>

<template>
  <div class="mana-taps">
    <button
      v-for="action in props.actions"
      :key="action.id"
      type="button"
      class="mana-tap"
      :title="title(action)"
      :aria-label="entry(action)?.summary ?? title(action)"
      @click.stop="emit('tap', action)"
    >
      <span
        v-for="(symbol, i) in symbols(action)"
        :key="i"
        class="mana-dot"
        :class="`mana-${symbol}`"
        >{{ symbol }}</span
      >
    </button>
  </div>
</template>

<style scoped>
.mana-taps {
  position: absolute;
  left: 4px;
  bottom: 4px;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.mana-tap {
  display: inline-flex;
  gap: 1px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: rgb(28 25 23 / 0.75);
  cursor: pointer;
}
.mana-tap:hover {
  background: var(--accent);
}
/* Mana-symbol circles in the printed symbols' colors, as in the top bar. */
.mana-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6rem;
  font-weight: 800;
  color: #1c1917;
  background: #d6d3d1;
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
</style>
