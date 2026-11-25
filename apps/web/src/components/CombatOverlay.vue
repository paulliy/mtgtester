<script setup lang="ts">
/**
 * The one line combat still draws across the board: while you hold a creature during a
 * declaration (picked up by a click, or dragged), a warm dashed curve runs from it to the pointer,
 * as in the combat lane proposal. Declared attacks and blocks are no longer drawn as standing
 * curves across the seats; the combat lane (`CombatLane.vue`) shows them as columns instead.
 *
 * Positions come from the anchor registry (each card tile registers there), so the line starts
 * at the tile wherever the layout puts it.
 */
import { computed, onBeforeUnmount, watch } from 'vue';
import { useBoardAnchors } from '../composables/useBoardAnchors';

/**
 * `dragSourceId`/`pointer`: the creature being held and the live pointer position, in the same
 * root-relative coordinate space as the anchor registry.
 */
const props = defineProps<{
  dragSourceId?: string | null;
  pointer?: { x: number; y: number } | null;
}>();

const { anchors, remeasureAnchors } = useBoardAnchors();

const round = (v: number) => Math.round(v);

/** A smooth vertical S from (x0, y0) to (x1, y1): leaves and arrives upright. */
function curve(x0: number, y0: number, x1: number, y1: number): string {
  const k = Math.max(30, Math.abs(y1 - y0) * 0.45);
  const dir = y1 < y0 ? -1 : 1;
  return `M${round(x0)} ${round(y0)} C${round(x0)} ${round(y0 + dir * k)} ${round(x1)} ${round(y1 - dir * k)} ${round(x1)} ${round(y1)}`;
}

const line = computed(() => {
  if (props.dragSourceId == null || props.pointer == null) return null;
  const card = anchors.get(props.dragSourceId);
  if (card === undefined) return null;
  const x0 = card.x + card.width / 2;
  const up = props.pointer.y < card.y + card.height / 2;
  const y0 = up ? card.y : card.y + card.height;
  return { d: curve(x0, y0, props.pointer.x, props.pointer.y), x0: round(x0), y0: round(y0) };
});

/** The held tile can move as the lane opens or the row reflows: measure while a line shows. */
let frame = 0;
function trackBoard(): void {
  remeasureAnchors();
  frame = requestAnimationFrame(trackBoard);
}
watch(
  () => props.dragSourceId != null,
  (active) => {
    cancelAnimationFrame(frame);
    if (active && typeof requestAnimationFrame === 'function') trackBoard();
  },
  { immediate: true },
);
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>

<template>
  <svg v-if="line" class="combat-overlay" aria-hidden="true">
    <g class="arrow drag">
      <path class="halo" :d="line.d" />
      <path class="ink" :d="line.d" stroke-dasharray="5 4" />
      <circle class="origin" :cx="line.x0" :cy="line.y0" r="3.5" />
    </g>
  </svg>
</template>

<style scoped>
.combat-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 5;
  overflow: visible;
}
.halo {
  fill: none;
  stroke: var(--paper);
  stroke-width: 6;
  stroke-linecap: round;
}
.ink {
  fill: none;
  stroke: var(--ink);
  stroke-width: 2;
  stroke-linecap: round;
}
.origin {
  fill: var(--ink);
  stroke: var(--paper);
  stroke-width: 1.5;
}
.drag .ink {
  stroke: var(--warm);
}
.drag .origin {
  fill: var(--warm);
}
</style>
