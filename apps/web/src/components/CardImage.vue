<script setup lang="ts">
/**
 * A real card image, resolved from Scryfall's CDN by `scryfallId` (brief §10.2's board/hand
 * requirements, satisfied with art instead of text). Falls back to a text-only
 * frame — never a broken-image icon — for cards with no printing (tokens) or a failed load.
 */
import { computed, ref, watch } from 'vue';
import { scryfallImageUrl } from '../lib/card';

const props = withDefaults(
  defineProps<{
    scryfallId: string | null;
    name: string;
    size: 'small' | 'normal' | 'large';
    /** Which face to request for a double-faced card image. */
    face?: 'front' | 'back';
    tapped?: boolean;
    /** True token/emblem with no real printing — always shows the striped placeholder. */
    isToken?: boolean;
  }>(),
  { face: 'front', tapped: false, isToken: false },
);

const failed = ref(false);
watch(
  () => [props.scryfallId, props.face],
  () => {
    failed.value = false;
  },
);

const TOKEN_SCRYFALL_IDS: Record<string, string> = {
  treasure: 'e0e98031-6450-4822-b52e-ec5f81f1816e',
  pest: '9a410c85-2e61-482c-b5f7-418ef0e0176a',
  dragon: 'a1670984-7a30-4e39-b9d9-f538e1215b22',
  'dragon token': 'a1670984-7a30-4e39-b9d9-f538e1215b22',
  goblin: 'b0e0081d-6169-4e36-a36a-2d9c02d6df38',
  zombie: '8a834e06-8c08-410a-bfa6-17b8ef3a72fb',
  food: '503a4669-e70a-4299-bbcf-543cb818fd3f',
  clue: '74c2ae77-1d54-473d-82d8-21d1d86d6eb1',
};

const src = computed(() => {
  let id = props.scryfallId;
  if ((id === null || id.length < 2) && props.name) {
    const key = props.name.toLowerCase().trim();
    id = TOKEN_SCRYFALL_IDS[key] ?? null;
  }
  if (id === null || id.length < 2) return null;
  return scryfallImageUrl(id, props.size, props.face);
});

const showImage = computed(() => !props.isToken && src.value !== null && !failed.value);

/** True tokens get "TOKEN"; a real card whose art failed/hasn't resolved gets its initials. */
const placeholderLabel = computed(() =>
  props.isToken ? 'TOKEN' : props.name.slice(0, 3).toUpperCase(),
);
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
    <div v-else class="fallback" role="img" :aria-label="name">
      <span class="fallback-label">{{ placeholderLabel }}</span>
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
  aspect-ratio: 63 / 88;
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
  transition:
    transform 120ms ease,
    width 120ms ease,
    height 120ms ease;
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
  background: repeating-linear-gradient(
    45deg,
    var(--surface-2),
    var(--surface-2) 4px,
    var(--line) 4px,
    var(--line) 8px
  );
  border-radius: 6%;
  box-sizing: border-box;
}
.fallback-label {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--muted);
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.6);
}
</style>
