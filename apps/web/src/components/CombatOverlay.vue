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
 * gets a chevron at its edge and an arrow from it straight across into the board it attacks (see
 * `attackArrow`), and each blocker a blue line to the attacker it blocks. These are still pictures, not motion, so they stay when
 * motion is reduced.
 */
import { computed, nextTick, onBeforeUnmount, watch } from 'vue';
import type { SpectatorPermanent } from '@mtg/shared';
import { useBoardAnchors, type AnchorRect } from '../composables/useBoardAnchors';
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
  /** An attack's chevron, at the creature's edge and turned the way the arrow points. */
  chevron?: { x: number; y: number; angle: number };
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

/**
 * Declared combat on the board: each attacker with the seat whose board it attacks (a
 * planeswalker's or battle's controller), and each blocker with the attacker it blocks.
 */
const combatPairs = computed(() => {
  const permanents = props.permanents ?? [];
  const controllerOf = new Map(permanents.map((p) => [p.id, p.controller]));
  return permanents.flatMap((p) => [
    ...(p.attacking !== null
      ? [
          {
            from: p.id,
            to: p.attacking,
            kind: 'attack' as const,
            toSeat: controllerOf.get(p.attacking) ?? p.attacking,
            tapped: p.tapped,
          },
        ]
      : []),
    ...(p.blocking !== null
      ? [{ from: p.id, to: p.blocking, kind: 'block' as const, toSeat: '', tapped: p.tapped }]
      : []),
  ]);
});

/** How far an attack arrow reaches past the border of the board it attacks. */
const ARROW_REACH = 34;
/** Room at the arrow's base for the chevron, which sits at the creature's edge. */
const CHEVRON_GAP = 28;

/**
 * The card as drawn: a tapped tile turns sideways at three quarters size (PermanentChip), so it
 * is 9/16 of its slot wide; the registry measures the slot.
 */
function cardRect(slot: AnchorRect, tapped: boolean): AnchorRect {
  if (!tapped) return slot;
  const width = slot.width * 0.5625;
  return { x: slot.x + (slot.width - width) / 2, y: slot.y, width, height: slot.height };
}

interface AttackArrow {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  chevron: { x: number; y: number; angle: number };
}

/**
 * An attack arrow, Arena-style: from the attacking creature straight to the nearest point of the
 * attacked board's border, and a little past it. A board beside the creature's row gets a level
 * arrow, one above or below gets an upright one, and only a diagonal board a slanted one. The
 * chevron sits at the creature's edge on that side, pointing the same way.
 */
function attackArrow(card: AnchorRect, board: AnchorRect): AttackArrow | null {
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  const px = Math.min(Math.max(cx, board.x), board.x + board.width);
  const py = Math.min(Math.max(cy, board.y), board.y + board.height);
  const length = Math.hypot(px - cx, py - cy);
  if (length === 0) return null;
  const ux = (px - cx) / length;
  const uy = (py - cy) / length;
  const edge = edgePoint(card, { x: px, y: py });
  return {
    x1: edge.x + ux * CHEVRON_GAP,
    y1: edge.y + uy * CHEVRON_GAP,
    x2: px + ux * ARROW_REACH,
    y2: py + uy * ARROW_REACH,
    chevron: {
      x: edge.x + ux * (CHEVRON_GAP / 2),
      y: edge.y + uy * (CHEVRON_GAP / 2),
      angle: (Math.atan2(uy, ux) * 180) / Math.PI,
    },
  };
}

const liveLines = computed<Line[]>(() => {
  const out: Line[] = [];
  for (const pair of combatPairs.value) {
    if (pair.kind === 'attack') {
      const slot = anchors.get(pair.from);
      const board = anchors.get(pair.toSeat);
      const arrow =
        slot !== undefined && board !== undefined
          ? attackArrow(cardRect(slot, pair.tapped), board)
          : null;
      if (arrow !== null) {
        out.push({
          key: `attack:${pair.from}`,
          ...arrow,
          dashed: false,
          current: false,
          kind: 'attack',
        });
        continue;
      }
    }
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

/**
 * A tile can move without anything resizing (a neighbour leaves, the row reflows, a scroll
 * container moves, a transition runs), and no observer reports that. So while declared combat is
 * on screen, measure every frame; `remeasureAnchors` only writes rects that changed, so this
 * costs a few `getBoundingClientRect` calls and no re-render when the board is still.
 */
let frame = 0;
function trackBoard(): void {
  remeasureAnchors();
  frame = requestAnimationFrame(trackBoard);
}
watch(
  () => combatPairs.value.length > 0,
  (active) => {
    cancelAnimationFrame(frame);
    if (active && typeof requestAnimationFrame === 'function') trackBoard();
  },
  { immediate: true },
);
onBeforeUnmount(() => cancelAnimationFrame(frame));

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
    <g
      v-for="line in lines.filter((l) => l.chevron)"
      :key="`chevron:${line.key}`"
      :transform="`translate(${line.chevron!.x} ${line.chevron!.y}) rotate(${line.chevron!.angle})`"
    >
      <path class="chevron" d="M -7 -14 L 7 0 L -7 14" />
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
  stroke-width: 6;
  stroke-linecap: butt;
}
line.live.attack {
  stroke: #fb923c;
  filter: drop-shadow(0 0 4px rgb(249 115 22 / 0.85));
}
line.live.block {
  stroke: #60a5fa;
  filter: drop-shadow(0 0 4px rgb(59 130 246 / 0.8));
}
/* The attack chevron, pulsing along the way the attack points. */
.chevron {
  fill: none;
  stroke: #fb923c;
  stroke-width: 7;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 5px rgb(249 115 22 / 0.95));
  animation: chevronPulse 1.1s ease-in-out infinite;
}
@keyframes chevronPulse {
  0%,
  100% {
    transform: translateX(-2px);
    opacity: 0.8;
  }
  50% {
    transform: translateX(3px);
    opacity: 1;
  }
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
