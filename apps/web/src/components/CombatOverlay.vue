<script setup lang="ts">
/**
 * Draws the combat lines ADR 0021 named as a deferred gap (§9.8.1): a dashed preview line per
 * pending attacker/blocker assignment while the combat-plan tray is being composed, a solid line
 * once it's been confirmed and is replaying, and a highlighted line for whichever subject is
 * currently being placed. Reads the existing `combatPlan` store and the anchor registry directly
 * — no new store, no protocol change. Absent whenever motion is reduced, matching the plan's
 * "overlay absent, existing badges stand alone" fallback.
 */
import { computed } from 'vue';
import { useBoardAnchors } from '../composables/useBoardAnchors';
import { useCombatPlanStore } from '../stores/combatPlan';
import { useGameStore } from '../stores/game';

/**
 * `dragSourceId`/`pointer` drive the drag-cursor line (§9.8.3): while a card is being dragged,
 * the caller reports the dragged object's id and the live pointer position (in the same
 * root-relative coordinate space as the anchor registry) so this layer can draw one extra line
 * from the source to the cursor, reusing the same anchor lookups as the combat lines.
 */
const props = defineProps<{
  dragSourceId?: string | null;
  pointer?: { x: number; y: number } | null;
}>();

const combatPlan = useCombatPlanStore();
const game = useGameStore();
const { anchors } = useBoardAnchors();

interface Line {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed: boolean;
  current: boolean;
  isDrag?: boolean;
}

function center(id: string): { x: number; y: number } | null {
  const rect = anchors.get(id);
  if (rect === undefined) return null;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

const lines = computed<Line[]>(() => {
  if (game.reducedMotion) return [];
  const out: Line[] = [];
  if (combatPlan.mode === 'composing' || combatPlan.mode === 'replaying') {
    for (const entry of combatPlan.order) {
      const targetId = combatPlan.assignment.get(entry.subjectId);
      if (targetId === undefined) continue;
      const from = center(entry.subjectId);
      const to = center(targetId);
      if (from === null || to === null) continue;
      out.push({
        key: entry.subjectId,
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        dashed: combatPlan.mode === 'composing',
        current: false, // Batched declarations have no per-creature replay cursor.
      });
    }
  }
  if (props.dragSourceId != null && props.pointer != null) {
    const from = center(props.dragSourceId);
    if (from !== null) {
      out.push({
        key: 'drag-cursor',
        x1: from.x,
        y1: from.y,
        x2: props.pointer.x,
        y2: props.pointer.y,
        dashed: true,
        current: false,
        isDrag: true,
      });
    }
  }
  return out;
});
</script>

<template>
  <svg v-if="lines.length > 0" class="combat-overlay" aria-hidden="true">
    <line
      v-for="line in lines"
      :key="line.key"
      :x1="line.x1"
      :y1="line.y1"
      :x2="line.x2"
      :y2="line.y2"
      :class="{ dashed: line.dashed, current: line.current, drag: line.isDrag }"
    />
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
line {
  stroke: rgb(248 113 113 / 0.75);
  stroke-width: 2.5;
  stroke-linecap: round;
}
line.dashed {
  stroke-dasharray: 6 5;
  stroke: rgb(248 113 113 / 0.45);
}
line.current {
  stroke: var(--accent);
  stroke-width: 3.5;
}
line.drag {
  stroke: var(--accent);
  stroke-width: 2;
  stroke-dasharray: 4 4;
}
</style>
