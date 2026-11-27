<script setup lang="ts">
/**
 * A brief full-screen cue when your turn begins: a warm frame around the viewport and "Your turn"
 * in the display face, fading out on its own. It is decoration over the board, never in the way:
 * it takes no pointer events, it is hidden from assistive technology (the top bar's "Your turn"
 * chip says the same in text), and it never plays under reduced motion.
 *
 * It plays once per turn number, so a re-render or a reconnect in the middle of your turn does not
 * replay it, and it waits while something else covers the board (the opening hand).
 */
import { onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{
  /** It is the viewer's turn. */
  active: boolean;
  /** The current turn number, so the cue plays once per turn. */
  turn: number | null;
  /** The game's reduced-motion setting. */
  reducedMotion: boolean;
  /** Something covers the board; hold the cue until it is gone. */
  suppressed?: boolean;
}>();

/** How long the cue stays, in milliseconds; matches the CSS animation. */
const FLASH_MS = 1600;

const playKey = ref(0);
const showing = ref(false);
let lastTurn: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function systemReducesMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

watch(
  () => [props.active, props.turn, props.suppressed, props.reducedMotion] as const,
  ([active, turn, suppressed, reduced]) => {
    if (!active || turn === null || suppressed === true || turn === lastTurn) return;
    lastTurn = turn;
    if (reduced || systemReducesMotion()) return;
    if (timer !== null) clearTimeout(timer);
    playKey.value += 1;
    showing.value = true;
    timer = setTimeout(() => {
      showing.value = false;
      timer = null;
    }, FLASH_MS);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer);
});
</script>

<template>
  <div v-if="showing" :key="playKey" class="your-turn-flash" aria-hidden="true">
    <span class="words">Your turn</span>
  </div>
</template>

<style scoped>
.your-turn-flash {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  box-shadow:
    inset 0 0 0 3px var(--warm),
    inset 0 0 90px 10px color-mix(in srgb, var(--warm) 35%, transparent);
  background: color-mix(in srgb, var(--paper) 30%, transparent);
  animation: your-turn-frame 1.6s var(--ease) both;
}
.words {
  font-family: var(--font-display);
  font-size: clamp(3rem, 11vw, 9rem);
  line-height: 1;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  color: var(--ink);
  text-shadow: 0 0 24px var(--paper);
  animation: your-turn-words 1.6s var(--ease) both;
}
@keyframes your-turn-frame {
  0% {
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  70% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes your-turn-words {
  0% {
    opacity: 0;
    transform: scale(1.06);
    letter-spacing: 0.04em;
  }
  20% {
    opacity: 1;
    transform: scale(1);
    letter-spacing: -0.03em;
  }
  70% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: scale(0.98);
  }
}
</style>
