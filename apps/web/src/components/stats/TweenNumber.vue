<script setup lang="ts">
/**
 * A number that counts to its value: from 0 on first mount, and from the old value to the new one
 * when the prop changes, so a figure changes in place instead of the box being replaced. Under
 * `prefers-reduced-motion` or the app's reduced-motion setting it just shows the value.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../../stores/game';

const props = withDefaults(
  defineProps<{
    value: number;
    decimals?: number;
    /** Show a leading + for positive values, and a true minus sign for negative ones. */
    signed?: boolean;
    suffix?: string;
    duration?: number;
  }>(),
  { decimals: 0, signed: false, suffix: '', duration: 800 },
);

const game = useGameStore();
let frame = 0;

function reduced(): boolean {
  return (
    game.reducedMotion ||
    (typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)
  );
}

const shown = ref(reduced() ? props.value : 0);

function tweenTo(target: number): void {
  cancelAnimationFrame(frame);
  if (reduced() || typeof requestAnimationFrame === 'undefined') {
    shown.value = target;
    return;
  }
  const from = shown.value;
  const start = performance.now();
  const step = (now: number): void => {
    const k = Math.min(1, (now - start) / props.duration);
    // Ease-out cubic, close to the page's --ease curve.
    shown.value = from + (target - from) * (1 - Math.pow(1 - k, 3));
    if (k < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

onMounted(() => tweenTo(props.value));
watch(
  () => props.value,
  (next) => tweenTo(next),
);
onBeforeUnmount(() => cancelAnimationFrame(frame));

function format(value: number): string {
  const text = Math.abs(value).toFixed(props.decimals);
  const zero = Number(text) === 0;
  if (!props.signed) return `${value < 0 && !zero ? '−' : ''}${text}`;
  return `${zero ? '' : value < 0 ? '−' : '+'}${text}`;
}
</script>

<template>
  <span class="tween">{{ format(shown) }}{{ suffix }}</span>
</template>
