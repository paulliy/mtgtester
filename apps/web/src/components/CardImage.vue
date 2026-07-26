<script setup lang="ts">
/**
 * A real card image, resolved from Scryfall's CDN by `scryfallId` (brief §10.2's board/hand
 * requirements, satisfied with art instead of text — see ADR 0013). Falls back to a text-only
 * frame — never a broken-image icon — for cards with no printing (tokens) or a failed load.
 */
import { computed, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    scryfallId: string | null;
    name: string;
    size: 'small' | 'normal' | 'large';
    tapped?: boolean;
  }>(),
  { tapped: false },
);

const failed = ref(false);
watch(
  () => props.scryfallId,
  () => {
    failed.value = false;
  },
);

const src = computed(() => {
  const id = props.scryfallId;
  if (id === null || id.length < 2) return null;
  return `https://cards.scryfall.io/${props.size}/front/${id[0]}/${id[1]}/${id}.jpg`;
});

const showImage = computed(() => src.value !== null && !failed.value);
</script>

<template>
  <div class="card-image" :class="[size, { tapped }]">
    <img
      v-if="showImage"
      :src="src ?? ''"
      :alt="name"
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
    <div v-else class="fallback">
      <span>{{ name }}</span>
    </div>
  </div>
</template>

<style scoped>
/*
 * The wrapper keeps its footprint fixed (still a portrait 5:7 box in the grid/flex flow) even
 * when tapped — only the image inside visually rotates. Rotating a 100%x100% image in place
 * would just crop it to a sliver (the portrait `object-fit: cover` crop happens *before* the
 * rotate, so 90° turns it into a thin strip). Instead the image is pre-sized to the *swapped*
 * (landscape) dimensions — width 140% / height ~71.4%, the inverse of the 5:7 ratio — centered,
 * then rotated: after the turn it exactly fills the portrait wrapper, like a real tapped card.
 */
.card-image {
  position: relative;
  aspect-ratio: 5 / 7;
  border-radius: 6%;
  overflow: hidden;
  background: var(--surface-2);
  flex-shrink: 0;
}
.card-image img {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transform: translate(-50%, -50%);
  transition: transform 120ms ease, width 120ms ease, height 120ms ease;
}
.card-image.tapped img {
  width: 140%;
  height: 71.43%;
  transform: translate(-50%, -50%) rotate(90deg);
}
.fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0.2rem;
  border: 1px solid var(--line);
  border-radius: 6%;
  box-sizing: border-box;
}
.fallback span {
  font-size: 0.65rem;
  line-height: 1.2;
  color: var(--muted);
  word-break: break-word;
}
</style>
