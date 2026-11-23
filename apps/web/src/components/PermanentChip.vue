<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { SpectatorPermanent } from '@mtg/shared';
import { useBoardAnchors } from '../composables/useBoardAnchors';
import { useBoardFlash } from '../composables/useBoardFlash';
import { STRIKE_MS, useCombatStrikes } from '../composables/useCombatStrikes';
import { scryfallImageUrl } from '../lib/card';
import type { TokenArtKey } from '../lib/tokenArt';
import { splitTypeLine } from '../lib/typeLine';
import ProvisionalBadge from './ProvisionalBadge.vue';
import { useCardPreviewStore } from '../stores/cardPreview';
import { useTokenArtStore } from '../stores/tokenArt';

const props = withDefaults(
  defineProps<{
    permanent: SpectatorPermanent;
    count?: number;
    /** Object/card id → display name, for naming a blocked attacker. Optional; falls back to id. */
    nameById?: Map<string, string> | undefined;
    /** This permanent is its controller's commander: a double ink frame and a tag. */
    isCommander?: boolean;
    /**
     * Your unconfirmed combat choice for it ("→ P4", "Blocks Ghalta"), shown in the top bar until
     * the declaration is confirmed and the engine's own attacking/blocking state takes over.
     */
    planTag?: string | null;
    /**
     * `line` draws the permanent as its name in a line of text, the way the board design lists an
     * opponent's lands under their cards; it keeps the tile's state marks for screen readers.
     */
    variant?: 'tile' | 'line';
  }>(),
  { count: 1, planTag: null, variant: 'tile' },
);

const cardPreview = useCardPreviewStore();
const tokenArtStore = useTokenArtStore();
const { registerAnchor, unregisterAnchor } = useBoardAnchors();

const isCreature = computed(() => props.permanent.power !== null);
/** The engine's flag. A snapshot saved before it existed lacks it and shows no token art. */
const isToken = computed(() => props.permanent.isToken === true);
const isAttacking = computed(() => props.permanent.attacking !== null);

/** Board-change feedback (§9.8): a brief flash when this permanent takes or sheds damage. */
const damageFlash = useBoardFlash(
  () => props.permanent.damageMarked,
  (prev, next) => (next > prev ? 'damage' : null),
);

/**
 * MTGA-style attack animation: when this permanent is the striking side of a combat damage event
 * (`useCombatStrikes`), lunge toward its target and back. The `striking` class is toggled off and
 * on across a tick rather than keyed/remounted, so a retrigger (e.g. first strike then regular
 * damage) restarts the CSS animation without tearing down the card image mid-hover.
 */
const { strikeFor } = useCombatStrikes();
const strike = computed(() => strikeFor(props.permanent.id));
const striking = ref(false);
watch(
  () => strike.value?.key,
  async (key) => {
    if (key === undefined) return;
    striking.value = false;
    await nextTick();
    striking.value = true;
    setTimeout(() => {
      striking.value = false;
    }, STRIKE_MS);
  },
);

const tileEl = ref<HTMLElement | null>(null);
function setTileEl(el: Element | ComponentPublicInstance | null): void {
  tileEl.value = el instanceof HTMLElement ? el : null;
}
/** Anchor id is the permanent's object id, so the combat overlay can draw a line to it. */
watch(
  () => props.permanent.id,
  (next, prev) => {
    if (prev !== undefined && prev !== next) unregisterAnchor(prev);
    if (tileEl.value !== null) registerAnchor(next, tileEl.value);
  },
);
watch(tileEl, (el) => {
  if (el !== null) registerAnchor(props.permanent.id, el);
});
onBeforeUnmount(() => unregisterAnchor(props.permanent.id));

/** Counters render as `+1/+1×2`, which is denser than one chip per kind. */
const counterText = computed(() =>
  Object.entries(props.permanent.counters)
    .filter(([, n]) => n !== 0)
    .map(([kind, n]) => `${kind}×${n}`)
    .join(' '),
);

/**
 * Counters drawn as a number per kind in the bottom-right corner, as in Arena, colored by kind:
 * green +1/+1, red -1/-1, purple loyalty, blue for anything else. The words are on hover.
 */
const COUNTER_TONES: Record<string, string> = {
  '+1/+1': 'plus',
  '-1/-1': 'minus',
  loyalty: 'loyalty',
};
const counterPips = computed(() =>
  Object.entries(props.permanent.counters)
    .filter(([, n]) => n !== 0)
    .map(([kind, n]) => ({
      kind,
      count: n,
      tone: COUNTER_TONES[kind] ?? 'other',
      title: `${n} ${kind} counter${n === 1 ? '' : 's'}`,
    })),
);

/** The printed type line, split into its supertypes, card types and subtypes. */
const typeParts = computed(() => splitTypeLine(props.permanent.typeLine ?? ''));
/** One tag on the art's lower left: the token mark first, then the first supertype. */
const artTag = computed(() => {
  if (isToken.value) return 'Token';
  return typeParts.value.supertypes[0] ?? null;
});

/** The ink bar across the top in combat: whom it attacks, or what it blocks. */
const combatTag = computed(() => {
  const p = props.permanent;
  if (p.attacking === null && p.blocking === null && props.planTag) return props.planTag;
  if (p.attacking !== null) {
    const target = p.attackingPlaneswalker ?? p.attacking;
    const blocked = p.blockedBy.length > 0 ? ' · blocked' : '';
    return `Attacking ${props.nameById?.get(target) ?? target}${blocked}`;
  }
  if (p.blocking !== null) return `Blocking ${props.nameById?.get(p.blocking) ?? p.blocking}`;
  return null;
});

/** The tile shows these states (rotation, a desaturated or lifted card, glows); hover names them. */
const statusLines = computed(() => {
  const p = props.permanent;
  const out: string[] = [];
  if (p.tapped) out.push('Tapped');
  if (p.summoningSick && isCreature.value) out.push('Summoning sick');
  if (p.attacking !== null) {
    // An attack on a planeswalker names the planeswalker, not its controller.
    const target = p.attackingPlaneswalker ?? p.attacking;
    out.push(`Attacking ${props.nameById?.get(target) ?? target}`);
  }
  if (p.blocking !== null) out.push(`Blocking ${props.nameById?.get(p.blocking) ?? p.blocking}`);
  return out;
});

/** Marked damage as a red wash rising from the foot of the art, in proportion to toughness. */
const damageShare = computed(() => {
  const { damageMarked, toughness } = props.permanent;
  if (damageMarked <= 0) return 0;
  if (toughness === null || toughness <= 0) return 0.5;
  return Math.min(1, damageMarked / toughness);
});

/**
 * Decktank tiles (redesign phase 5): a 5:7 paper card in a 1px ink frame with its name, its
 * illustration (Scryfall's `art_crop`), its type line and a P/T box; the full card, with its text
 * and live state, is the hover preview. A token copy of a real card shows that card's art, and any
 * other token borrows a matching printed token's (`tokenArt`).
 */
const tokenArtKey = computed<TokenArtKey | null>(() => {
  const p = props.permanent;
  // Colors pick the right printing; a snapshot saved before they were sent can't be matched.
  if (!isToken.value || p.scryfallId !== null || p.colors === undefined) return null;
  return {
    name: p.name,
    typeLine: p.typeLine,
    colors: p.colors,
    power: p.power,
    toughness: p.toughness,
  };
});
const tokenArt = computed(() =>
  tokenArtKey.value === null ? null : (tokenArtStore.lookup(tokenArtKey.value) ?? null),
);
/** The printing this tile draws from: its own, or a borrowed token printing. */
const printing = computed(() =>
  props.permanent.scryfallId !== null
    ? { scryfallId: props.permanent.scryfallId, face: props.permanent.imageFace ?? 'front' }
    : tokenArt.value === null
      ? null
      : { scryfallId: tokenArt.value.scryfallId, face: tokenArt.value.face },
);
const artFailed = ref(false);
watch(
  () => [printing.value?.scryfallId, printing.value?.face],
  () => {
    artFailed.value = false;
  },
);
const artSrc = computed(() => {
  const p = printing.value;
  if (artFailed.value || p === null || p.scryfallId.length < 2) return null;
  return scryfallImageUrl(p.scryfallId, 'art_crop', p.face);
});

const ptText = computed(() =>
  isCreature.value ? `${props.permanent.power}/${props.permanent.toughness}` : null,
);
const hurt = computed(() => props.permanent.damageMarked > 0);

function onEnter(event: MouseEvent): void {
  const p = props.permanent;
  // A borrowed token printing shows whole only when it matched on P/T too; otherwise the preview
  // falls back to the token's own text rather than a card with the wrong numbers.
  const exactArt = tokenArt.value?.exact === true ? tokenArt.value : null;
  cardPreview.show({
    scryfallId: p.scryfallId ?? exactArt?.scryfallId ?? null,
    name: p.name,
    imageFace: p.scryfallId !== null ? (p.imageFace ?? 'front') : (exactArt?.face ?? 'front'),
    typeLine: p.typeLine,
    manaCost: p.manaCost,
    oracleText: p.oracleText,
    power: p.power,
    toughness: p.toughness,
    keywords: p.keywords,
    counters: counterText.value,
    damageMarked: p.damageMarked,
    status: statusLines.value,
  });
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onMove(event: MouseEvent): void {
  cardPreview.updateCursor(event.clientX, event.clientY);
}
function onLeave(): void {
  cardPreview.hide();
}
</script>

<template>
  <div
    :ref="setTileEl"
    class="tile"
    :class="{
      line: variant === 'line',
      token: isToken,
      commander: isCommander,
      tapped: permanent.tapped,
      sick: permanent.summoningSick && isCreature,
      attacking: isAttacking,
      blocking: permanent.blocking !== null,
      striking,
      'taking-damage': damageFlash === 'damage',
    }"
    :style="
      strike
        ? {
            '--strike-dx': strike.dx + 'px',
            '--strike-dy': strike.dy + 'px',
            '--strike-ms': `${STRIKE_MS}ms`,
          }
        : undefined
    "
    @mouseenter="onEnter"
    @mousemove="onMove"
    @mouseleave="onLeave"
  >
    <ProvisionalBadge v-if="permanent.provisional === true && variant === 'tile'" />
    <span v-if="variant === 'line'" class="line-name">
      <span class="frame" role="img" :aria-label="permanent.name">{{ permanent.name }}</span
      ><span v-if="count && count > 1" class="stack-count-badge">×{{ count }}</span>
    </span>
    <div v-else class="card">
      <span
        v-if="combatTag"
        class="combat-tag"
        :class="{ blocking: permanent.blocking !== null }"
        aria-hidden="true"
        >{{ combatTag }}</span
      >
      <span v-else-if="isCommander" class="combat-tag cmdr" aria-hidden="true">Commander</span>
      <!-- Hidden from screen readers, which already hear the name from the frame's label. -->
      <span class="name" aria-hidden="true">{{ permanent.name }}</span>
      <div class="frame" role="img" :aria-label="permanent.name">
        <img
          v-if="artSrc"
          :src="artSrc"
          alt=""
          loading="lazy"
          decoding="async"
          @error="artFailed = true"
        />
        <span
          v-if="damageShare > 0"
          class="damage-wash"
          :style="{ height: `${damageShare * 100}%` }"
          aria-hidden="true"
        />
        <span v-if="permanent.tapped" class="hatch" aria-hidden="true" />
        <span v-if="artTag" class="art-tag" aria-hidden="true">{{ artTag }}</span>
      </div>
      <span
        v-if="typeParts.types"
        class="type-line"
        :class="{ 'beside-pt': ptText !== null }"
        aria-hidden="true"
      >
        <span class="types">{{ typeParts.types }}</span>
        <span v-if="typeParts.subtypes" class="subtypes">{{ typeParts.subtypes }}</span>
      </span>
      <!-- Lower right, as on a printed card: a number per counter kind, then the P/T box. -->
      <div v-if="counterPips.length > 0 || ptText !== null" class="corner">
        <span
          v-for="pip in counterPips"
          :key="pip.kind"
          class="pip"
          :class="pip.tone"
          :title="pip.title"
          aria-hidden="true"
        >
          {{ pip.count }}
        </span>
        <span
          v-if="ptText !== null"
          class="pt"
          :class="{ 'flash-damage': damageFlash === 'damage' }"
          >{{ permanent.power }}/<span :class="{ hurt }">{{ permanent.toughness }}</span></span
        >
      </div>
      <span v-if="permanent.tapped" class="tap-word" aria-hidden="true">Tapped</span>
      <div
        v-if="count && count > 1"
        class="stack-count-badge"
        :title="`${count} copies of ${permanent.name}`"
      >
        ×{{ count }}
      </div>
    </div>
    <!-- The tile shows these states with marks; this text keeps them for anyone who can't see
         or hover the card. -->
    <span v-if="permanent.tapped" class="tap-badge visually-hidden" title="Tapped">TAP</span>
    <span v-if="permanent.damageMarked > 0" class="dmg visually-hidden">
      −{{ permanent.damageMarked }}
    </span>
    <span v-if="counterText" class="counters visually-hidden">{{ counterText }}</span>
    <span v-if="statusLines.length > 0" class="marks visually-hidden">
      {{ statusLines.join(', ') }}
    </span>
    <span
      v-if="permanent.keywords.length > 0"
      class="keywords visually-hidden"
      :title="permanent.keywords.join(', ')"
    >
      {{ permanent.keywords.join(', ') }}
    </span>
  </div>
</template>

<style scoped>
/*
 * `container-type` lets the type below size itself off the tile's own width (`cqw`): parents size
 * tiles to their zone (`--chip-w`), so a fixed font size would overflow a small tile and look lost
 * on a large one. Values follow docs/design/decktank/Board.dc.html.
 */
.tile {
  position: relative;
  width: var(--chip-w, 108px);
  flex: 0 0 auto;
  container-type: inline-size;
  transition:
    transform 120ms ease,
    width 150ms ease,
    opacity 200ms ease;
}
.card {
  position: relative;
  aspect-ratio: 5 / 7;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  transition:
    translate 150ms var(--ease),
    box-shadow 150ms var(--ease);
}
.tile.commander .card {
  border: 3px double var(--ink);
}
.combat-tag {
  flex-shrink: 0;
  padding: 2% 5%;
  border-bottom: 1px solid var(--ink);
  background: var(--ink);
  color: var(--paper);
  font-family: var(--font-ui);
  font-size: max(9px, 8cqw);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.combat-tag.cmdr,
.combat-tag.blocking {
  background: var(--paper);
  color: var(--ink);
}
.name {
  flex-shrink: 0;
  margin: 5% 6% 3%;
  font-family: var(--font-ui);
  font-size: max(10px, 9.5cqw);
  line-height: 1.12;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.frame {
  position: relative;
  flex: 1;
  min-height: 0;
  margin: 0 6% 4%;
  overflow: hidden;
  background: var(--paper-2);
}
.frame img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: filter 200ms ease;
}
.tile.sick .frame img {
  filter: grayscale(0.7);
}
/* Tapped: ink hatching over the art, and the word, rather than turning the card. */
.hatch {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    135deg,
    color-mix(in srgb, var(--ink) 55%, transparent) 0 1px,
    transparent 1px 7px
  );
  pointer-events: none;
}
.tile.tapped .frame img {
  filter: brightness(0.86) saturate(0.8);
}
.art-tag {
  position: absolute;
  left: 5%;
  bottom: 5%;
  padding: 1px 4px;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: max(7px, 6.2cqw);
  line-height: 1.3;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.type-line {
  flex-shrink: 0;
  padding: 0 6% 6% 6%;
  font-family: var(--font-body);
  font-size: 7.5cqw;
  line-height: 1.3;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
}
.type-line.beside-pt {
  padding-right: 42%;
}
.type-line > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.type-line .subtypes {
  font-family: var(--font-display);
  font-size: 1.3em;
  line-height: 1.15;
  color: var(--ink);
}
.damage-wash {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(
    to top,
    color-mix(in srgb, var(--danger) 55%, transparent),
    color-mix(in srgb, var(--danger) 15%, transparent)
  );
  border-top: 1px solid var(--danger);
  pointer-events: none;
  transition: height 250ms ease;
}
.tile.taking-damage::after {
  content: '';
  position: absolute;
  inset: -3px;
  border: 2px solid var(--danger);
  opacity: 0;
  pointer-events: none;
  animation: damageImpact 720ms ease-out;
}
.tile.striking {
  animation-name: strike;
  animation-duration: var(--strike-ms, 520ms);
  animation-timing-function: cubic-bezier(0.22, 0.68, 0.32, 1.15);
  animation-fill-mode: both;
  z-index: 6;
}
@keyframes strike {
  0% {
    transform: translate(0, 0) scale(1);
  }
  18% {
    transform: translate(0, -8px) scale(1.06);
  }
  48%,
  62% {
    transform: translate(var(--strike-dx, 0px), var(--strike-dy, 0px)) scale(1.14);
  }
  100% {
    transform: translate(0, 0) scale(1);
  }
}
@keyframes damageImpact {
  0% {
    opacity: 0;
    transform: scale(1.08);
  }
  20% {
    opacity: 1;
    transform: scale(0.98);
  }
  42% {
    opacity: 0.82;
    transform: scale(1.015);
  }
  100% {
    opacity: 0;
    transform: scale(1);
  }
}
.stack-count-badge {
  position: absolute;
  right: 4%;
  top: 30%;
  z-index: 3;
  padding: 2% 6%;
  background: var(--ink);
  color: var(--paper);
  font-family: var(--font-ui);
  font-size: max(9px, 11cqw);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.tap-word {
  position: absolute;
  left: 4%;
  top: 30%;
  z-index: 3;
  padding: 2% 5%;
  border: 1px solid var(--ink);
  background: var(--paper);
  font-family: var(--font-ui);
  font-size: max(8px, 8cqw);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  pointer-events: none;
}
/* Counters and the P/T box share the lower right corner, as on a printed card. */
.corner {
  position: absolute;
  right: 4%;
  bottom: 3%;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 3px;
  pointer-events: none;
}
.corner .pt {
  padding: 3% 5%;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: max(11px, 12cqw);
  letter-spacing: 0.02em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* Damaged toughness turns red. */
.hurt {
  color: var(--danger);
}
.corner .pt.flash-damage {
  animation: flash 0.8s ease-out;
}
/* A counter is its number in an ink box; +1/+1 and loyalty filled, -1/-1 in the danger colour. */
.pip {
  min-width: max(1.05rem, 13cqw);
  height: max(1.05rem, 13cqw);
  padding: 0 0.2rem;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: max(0.6rem, 10cqw);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.pip.plus,
.pip.loyalty {
  background: var(--ink);
  color: var(--paper);
}
.pip.minus {
  border-color: var(--danger);
  color: var(--danger);
}
@container (max-width: 90px) {
  .type-line {
    display: none;
  }
}
@container (max-width: 70px) {
  .art-tag {
    display: none;
  }
}
@container (max-width: 112px) {
  .tap-word {
    display: none;
  }
}
/* A land in an opponent's lands line: its name and copies; a tapped one reads muted. */
.tile.line {
  width: auto;
  container-type: normal;
  display: inline;
}
.line-name {
  display: inline;
  white-space: nowrap;
}
.line-name .frame {
  display: inline;
  margin: 0;
  overflow: visible;
  background: none;
  flex: none;
}
.line-name .stack-count-badge {
  position: static;
  margin-left: 0.3em;
  padding: 0;
  background: none;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
}
.tile.line.tapped .line-name {
  color: var(--muted);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
