<script setup lang="ts">
import { computed } from 'vue';
import type { SpectatorPermanent } from '@mtg/shared';
import CardImage from './CardImage.vue';
import { useCardPreviewStore } from '../stores/cardPreview';

const props = withDefaults(
  defineProps<{
    permanent: SpectatorPermanent;
    count?: number;
  }>(),
  { count: 1 },
);

const cardPreview = useCardPreviewStore();

const isCreature = computed(() => props.permanent.power !== null);

/** Counters render as `+1/+1×2`, which is denser than one chip per kind. */
const counterText = computed(() =>
  Object.entries(props.permanent.counters)
    .filter(([, n]) => n !== 0)
    .map(([kind, n]) => `${kind}×${n}`)
    .join(' '),
);

const marks = computed(() => {
  const out: string[] = [];
  if (props.permanent.attacking !== null) out.push('⚔');
  if (props.permanent.blocking !== null) out.push('🛡');
  if (props.permanent.summoningSick) out.push('zzz');
  return out;
});

function onEnter(event: MouseEvent): void {
  cardPreview.show({ scryfallId: props.permanent.scryfallId, name: props.permanent.name });
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
    class="tile"
    :class="{ creature: isCreature, tapped: permanent.tapped }"
    @mouseenter="onEnter"
    @mousemove="onMove"
    @mouseleave="onLeave"
  >
    <div v-if="count && count > 1" class="stack-count-badge" :title="`${count} copies of ${permanent.name}`">
      ×{{ count }}
    </div>
    <div v-if="permanent.tapped" class="tap-badge" title="Tapped">TAP</div>
    <CardImage
      :scryfall-id="permanent.scryfallId"
      :name="permanent.name"
      size="small"
      :tapped="permanent.tapped"
    />
    <div v-if="permanent.keywords.length > 0" class="keywords" :title="permanent.keywords.join(', ')">
      {{ permanent.keywords.join(' · ') }}
    </div>
    <div class="overlay">
      <span v-if="isCreature" class="pt">
        {{ permanent.power }}/{{ permanent.toughness }}
        <span v-if="permanent.damageMarked > 0" class="dmg">−{{ permanent.damageMarked }}</span>
      </span>
      <span v-if="counterText" class="counters">{{ counterText }}</span>
      <span v-if="marks.length > 0" class="marks">{{ marks.join(' ') }}</span>
    </div>
  </div>
</template>

<style scoped>
.tile {
  position: relative;
  width: 88px;
  transition: transform 120ms ease;
}
.tile.creature {
  box-shadow: 0 0 0 2px var(--accent);
  border-radius: 6%;
}
.tile.tapped {
  opacity: 0.85;
}
.stack-count-badge {
  position: absolute;
  top: -5px;
  left: -5px;
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  color: #ffffff;
  border: 1.5px solid #ffffff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
  font-size: 0.65rem;
  font-weight: 800;
  padding: 0.08rem 0.35rem;
  border-radius: 10px;
  z-index: 10;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
}
.tap-badge {
  position: absolute;
  top: 3px;
  right: 3px;
  background: rgba(0, 0, 0, 0.8);
  color: var(--warn);
  border: 1px solid var(--warn);
  font-size: 0.52rem;
  font-weight: 700;
  padding: 0.05rem 0.2rem;
  border-radius: 3px;
  z-index: 2;
  pointer-events: none;
}
.keywords {
  position: absolute;
  inset: 0 0 auto 0;
  padding: 0.1rem 0.25rem;
  background: linear-gradient(to bottom, rgb(0 0 0 / 0.7), transparent);
  border-radius: 6% 6% 0 0;
  font-size: 0.58rem;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.overlay {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  padding: 0.15rem 0.25rem;
  background: linear-gradient(to top, rgb(0 0 0 / 0.75), transparent);
  border-radius: 0 0 6% 6%;
  pointer-events: none;
}
.pt {
  font-size: 0.68rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
  white-space: nowrap;
}
.dmg {
  color: #ff8a80;
}
.counters,
.marks {
  font-size: 0.6rem;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
}
</style>
