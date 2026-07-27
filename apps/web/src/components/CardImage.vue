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
      <div class="fallback-frame">
        <span class="token-badge" v-if="!scryfallId">TOKEN</span>
        <span class="fallback-name">{{ name }}</span>
      </div>
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
  padding: 0.3rem;
  background: var(--surface-2);
  border: 1px solid var(--accent);
  border-radius: 6%;
  box-sizing: border-box;
}
.fallback-frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.2rem;
  width: 100%;
}
.token-badge {
  font-size: 0.55rem;
  font-weight: 700;
  color: var(--warn);
  letter-spacing: 0.08em;
  background: rgb(224 179 65 / 0.15);
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  border: 1px solid rgb(224 179 65 / 0.4);
}
.fallback-name {
  font-size: 0.68rem;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text);
  word-break: break-word;
}
</style>
