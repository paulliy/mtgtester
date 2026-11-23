<script setup lang="ts">
/**
 * Combat drawn in ink, as the Decktank board design draws it (docs/design/decktank/Board.dc.html):
 * a curve from each attacker to the life total of the player it attacks (or to the planeswalker it
 * attacks), and a dotted line from each blocker to the attacker it blocks, ending in a bar. Lines
 * you have chosen but not confirmed yet are dashed. Every line has a paper halo so it reads where
 * it crosses a card or a rule, and the labels it passes sit above it on their own paper.
 *
 * The strip above your side says the same in words; these are pictures, not motion, so they stay
 * when motion is reduced. Positions come from the anchor registry (each card tile, each seat and
 * each seat's life total register there), so the lines follow any layout and any number of cards.
 */
import { computed, nextTick, onBeforeUnmount, watch } from 'vue';
import type { SpectatorPermanent } from '@mtg/shared';
import { useBoardAnchors, type AnchorRect } from '../composables/useBoardAnchors';
import { useCombatPlanStore } from '../stores/combatPlan';

/**
 * `dragSourceId`/`pointer` drive the drag-cursor line (§9.8.3): while a card is being dragged,
 * the caller reports the dragged object's id and the live pointer position (in the same
 * root-relative coordinate space as the anchor registry) so this layer can draw one extra line
 * from the source to the cursor.
 */
const props = defineProps<{
  dragSourceId?: string | null;
  pointer?: { x: number; y: number } | null;
  permanents?: readonly SpectatorPermanent[];
}>();

const combatPlan = useCombatPlanStore();
const { anchors, remeasureAnchors } = useBoardAnchors();

type Kind = 'attack' | 'pending' | 'block' | 'drag';

interface Arrow {
  key: string;
  kind: Kind;
  d: string;
  head: string;
  x0: number;
  y0: number;
}

interface Pair {
  from: string;
  to: string;
  /** For attacks on a player: the seat, whose life total the arrow points at. */
  seat: string | null;
  kind: 'attack' | 'pending' | 'block' | 'pendingBlock';
}

/** Declared combat on the board, then the declaration you are composing. */
const pairs = computed<Pair[]>(() => {
  const out: Pair[] = [];
  const planned = new Set<string>();
  if (combatPlan.mode === 'composing' || combatPlan.mode === 'replaying') {
    const onBoard = new Set((props.permanents ?? []).map((p) => p.id));
    for (const [subject, target] of combatPlan.assignment) {
      planned.add(subject);
      // An attacker's target is a player unless it is a permanent (a planeswalker or battle).
      const toSeat = combatPlan.kind === 'attackers' && !onBoard.has(target);
      out.push({
        from: subject,
        to: target,
        seat: toSeat ? target : null,
        kind: combatPlan.kind === 'attackers' ? 'pending' : 'pendingBlock',
      });
    }
  }
  for (const p of props.permanents ?? []) {
    if (planned.has(p.id)) continue;
    if (p.attacking !== null) {
      const walker = p.attackingPlaneswalker ?? null;
      out.push({
        from: p.id,
        to: walker ?? p.attacking,
        seat: walker === null ? p.attacking : null,
        kind: 'attack',
      });
    }
    if (p.blocking !== null) out.push({ from: p.id, to: p.blocking, seat: null, kind: 'block' });
  }
  return out;
});

const midX = (r: AnchorRect) => r.x + r.width / 2;
const midY = (r: AnchorRect) => r.y + r.height / 2;
const round = (v: number) => Math.round(v);

/** A smooth vertical S from (x0, y0) to (x1, y1): leaves and arrives upright. */
function curve(x0: number, y0: number, x1: number, y1: number): string {
  const k = Math.max(30, Math.abs(y1 - y0) * 0.45);
  const dir = y1 < y0 ? -1 : 1;
  return `M${round(x0)} ${round(y0)} C${round(x0)} ${round(y0 + dir * k)} ${round(x1)} ${round(y1 - dir * k)} ${round(x1)} ${round(y1)}`;
}

const arrows = computed<Arrow[]>(() => {
  const out: Arrow[] = [];
  // Several attacks at one life total fan out side by side instead of stacking.
  const perTarget = new Map<string, number>();
  for (const pair of pairs.value) {
    if (pair.kind === 'attack' || pair.kind === 'pending')
      perTarget.set(pair.to, (perTarget.get(pair.to) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const pair of pairs.value) {
    const card = anchors.get(pair.from);
    if (card === undefined) continue;
    if (pair.kind === 'block' || pair.kind === 'pendingBlock') {
      const attacker = anchors.get(pair.to);
      if (attacker === undefined) continue;
      const down = midY(card) < midY(attacker);
      const x0 = midX(card);
      const y0 = down ? card.y + card.height : card.y;
      const x1 = attacker.x + attacker.width * 0.72;
      const y1 = down ? attacker.y - 2 : attacker.y + attacker.height + 2;
      out.push({
        key: `block:${pair.from}`,
        kind: pair.kind === 'block' ? 'block' : 'pending',
        d: curve(x0, y0, x1, y1),
        head: `M${round(x1 - 9)} ${round(y1 - 1.5)} H${round(x1 + 9)} V${round(y1 + 1.5)} H${round(x1 - 9)} Z`,
        x0: round(x0),
        y0: round(y0),
      });
      continue;
    }
    const target =
      (pair.seat !== null ? anchors.get(`life:${pair.seat}`) : undefined) ??
      anchors.get(pair.to) ??
      (pair.seat !== null ? anchors.get(pair.seat) : undefined);
    if (target === undefined) continue;
    const n = perTarget.get(pair.to) ?? 1;
    const i = (seen.get(pair.to) ?? 0) + 1;
    seen.set(pair.to, i);
    const up = midY(target) < midY(card);
    const x0 = card.x + card.width * 0.32;
    const y0 = up ? card.y - 2 : card.y + card.height + 2;
    const x1 = midX(target) + (i - 1 - (n - 1) / 2) * 16;
    const y1 = up ? target.y + target.height + 4 : target.y - 4;
    const s = up ? 1 : -1;
    out.push({
      key: `attack:${pair.from}`,
      kind: pair.kind === 'attack' ? 'attack' : 'pending',
      d: curve(x0, y0, x1, y1),
      head: `M${round(x1)} ${round(y1)} L${round(x1 - 6)} ${round(y1 + s * 11)} L${round(x1 + 6)} ${round(y1 + s * 11)} Z`,
      x0: round(x0),
      y0: round(y0),
    });
  }
  if (props.dragSourceId != null && props.pointer != null) {
    const card = anchors.get(props.dragSourceId);
    if (card !== undefined) {
      const x0 = midX(card);
      const y0 = card.y;
      out.push({
        key: 'drag-cursor',
        kind: 'drag',
        d: curve(x0, y0, props.pointer.x, props.pointer.y),
        head: '',
        x0: round(x0),
        y0: round(y0),
      });
    }
  }
  return out;
});

/**
 * Tiles move as combat starts and as others enter or leave, and the registry only measures on
 * mount and resize, so measure again once that has settled.
 */
watch(
  () => pairs.value.map((pair) => `${pair.from}>${pair.to}`).join(),
  async () => {
    await nextTick();
    remeasureAnchors();
    setTimeout(remeasureAnchors, 250);
  },
  { immediate: true },
);

/**
 * A tile can move without anything resizing (a neighbour leaves, the row reflows, a scroll
 * container moves, a transition runs), and no observer reports that. So while combat is on
 * screen, measure every frame; `remeasureAnchors` only writes rects that changed, so this costs a
 * few `getBoundingClientRect` calls and no re-render when the board is still.
 */
let frame = 0;
function trackBoard(): void {
  remeasureAnchors();
  frame = requestAnimationFrame(trackBoard);
}
watch(
  () => pairs.value.length > 0,
  (active) => {
    cancelAnimationFrame(frame);
    if (active && typeof requestAnimationFrame === 'function') trackBoard();
  },
  { immediate: true },
);
onBeforeUnmount(() => cancelAnimationFrame(frame));

const DASH: Record<Kind, string> = { attack: 'none', pending: '10 6', block: '0.1 6', drag: '4 5' };
</script>

<template>
  <svg v-if="arrows.length > 0" class="combat-overlay" aria-hidden="true">
    <g v-for="arrow in arrows" :key="arrow.key" :class="['arrow', arrow.kind]">
      <path class="halo" :d="arrow.d" />
      <path class="ink" :d="arrow.d" :stroke-dasharray="DASH[arrow.kind]" />
      <path v-if="arrow.head" class="head" :d="arrow.head" />
      <circle class="origin" :cx="arrow.x0" :cy="arrow.y0" r="3.5" />
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
.block .ink {
  stroke-width: 3;
}
.head,
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
