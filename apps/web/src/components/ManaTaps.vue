<script setup lang="ts">
/**
 * Mana you can make by hand from one permanent (ADR 0030): a button per kind of mana its mana
 * abilities can make, drawn over the bottom-left corner of its tile.
 */
import type { ActionPresentation } from '@mtg/shared';
import type { LegalAction } from '../lib/protocol';

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
  background: var(--paper-2);
}
/* Colour identity in the muted Decktank colours, as in the top bar (ADR 0052). */
.mana-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6rem;
  font-family: var(--font-display);
  font-weight: 400;
  line-height: 1;
  color: var(--mana-letter);
  background: var(--mana-c);
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
</style>
