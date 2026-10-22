<script setup lang="ts">
/**
 * Draws the combat lines ADR 0021 named as a deferred gap (§9.8.1): a dashed preview line per
 * pending attacker/blocker assignment while the combat-plan tray is being composed, a solid line
 * once it's been confirmed and is replaying, and a highlighted line for whichever subject is
 * currently being placed. Reads the existing `combatPlan` store and the anchor registry directly
 * — no new store, no protocol change. Absent whenever motion is reduced, matching the plan's
 * "overlay absent, existing badges stand alone" fallback.
 *
 * Declared combat is drawn too, from the board itself (`permanents`): Arena-style, each attacker
 * gets a line to the seat or permanent it attacks, ending in an arrowhead, and each blocker a
 * blue line to the attacker it blocks. These are still pictures, not motion, so they stay when
 * motion is reduced.
 */
import { computed, nextTick, watch } from 'vue';
import type { SpectatorPermanent } from '@mtg/shared';
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
  permanents?: readonly SpectatorPermanent[];
}>();

const combatPlan = useCombatPlanStore();
const game = useGameStore();
const { anchors, remeasureAnchors } = useBoardAnchors();

interface Line {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed: boolean;
  current: boolean;
  isDrag?: boolean;
  kind?: 'attack' | 'block';
}

function center(id: string): { x: number; y: number } | null {
  const rect = anchors.get(id);
  if (rect === undefined) return null;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Where the segment from `from` toward `to` leaves the rect around `from`, so a line starts at a
 * card's edge (or ends at a seat's edge) instead of crossing its face.
 */
function edgePoint(
  rect: { x: number; y: number; width: number; height: number },
  toward: { x: number; y: number },
): { x: number; y: number } {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy),
  );
  return { x: cx + dx * Math.min(1, scale), y: cy + dy * Math.min(1, scale) };
}

/** One line per declared attacker and blocker on the board, from its card to what it fights. */
const combatPairs = computed(() =>
  (props.permanents ?? []).flatMap((p) => [
    ...(p.attacking !== null ? [{ from: p.id, to: p.attacking, kind: 'attack' as const }] : []),
    ...(p.blocking !== null ? [{ from: p.id, to: p.blocking, kind: 'block' as const }] : []),
  ]),
);

const liveLines = computed<Line[]>(() => {
  const out: Line[] = [];
  for (const pair of combatPairs.value) {
    const fromRect = anchors.get(pair.from);
    const toRect = anchors.get(pair.to);
    if (fromRect === undefined || toRect === undefined) continue;
    const fromCenter = center(pair.from)!;
    const toCenter = center(pair.to)!;
    const start = edgePoint(fromRect, toCenter);
    const end = edgePoint(toRect, fromCenter);
    out.push({
      key: `${pair.kind}:${pair.from}`,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      dashed: false,
      current: false,
      kind: pair.kind,
    });
  }
  return out;
});

/**
 * Tiles move as combat starts (attackers step forward and tap) and as others enter or leave,
 * and the registry only measures on mount and resize, so measure again once that has settled.
 */
watch(
  () => combatPairs.value.map((pair) => `${pair.from}>${pair.to}`).join(),
  async () => {
    await nextTick();
    remeasureAnchors();
    setTimeout(remeasureAnchors, 250);
  },
  { immediate: true },
);

const planLines = computed<Line[]>(() => {
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

const lines = computed<Line[]>(() => {
  const planned = planLines.value;
  const plannedKeys = new Set(planned.map((line) => line.key));
  // While the player's own plan replays, its line already stands for that creature.
  return [
    ...planned,
    ...liveLines.value.filter((line) => !plannedKeys.has(line.key.split(':')[1] ?? '')),
  ];
});
</script>

<template>
  <svg v-if="lines.length > 0" class="combat-overlay" aria-hidden="true">
    <defs>
      <marker
        id="combat-arrow-attack"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="5"
        markerHeight="5"
        orient="auto-start-reverse"
      >
        <path d="M0 0 L10 5 L0 10 L3 5 Z" class="head attack" />
      </marker>
      <marker
        id="combat-arrow-block"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="5"
        markerHeight="5"
        orient="auto-start-reverse"
      >
        <path d="M0 0 L10 5 L0 10 L3 5 Z" class="head block" />
      </marker>
    </defs>
    <line
      v-for="line in lines"
      :key="line.key"
      :x1="line.x1"
      :y1="line.y1"
      :x2="line.x2"
      :y2="line.y2"
      :marker-end="line.kind ? `url(#combat-arrow-${line.kind})` : undefined"
      :class="[
        { dashed: line.dashed, current: line.current, drag: line.isDrag },
        line.kind ? `live ${line.kind}` : '',
      ]"
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
/* Declared combat: a glowing orange line to what an attacker attacks, blue from a blocker. */
line.live {
  stroke-width: 4;
}
line.live.attack {
  stroke: #fb923c;
  filter: drop-shadow(0 0 4px rgb(249 115 22 / 0.85));
}
line.live.block {
  stroke: #60a5fa;
  filter: drop-shadow(0 0 4px rgb(59 130 246 / 0.8));
}
.head.attack {
  fill: #fb923c;
}
.head.block {
  fill: #60a5fa;
}
line.drag {
  stroke: var(--accent);
  stroke-width: 2;
  stroke-dasharray: 4 4;
}
</style>
