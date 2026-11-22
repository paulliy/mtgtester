<script setup lang="ts">
/**
 * The top bar's places, drawn as a ruler (redesign plan, phase 2; `TopBar.dc.html`): every place
 * sits on a tick, the first of each group on a tall one with its numeral above, and a warm tick
 * marks where you are. Pointing at a place slides the warm tick to it; leaving puts it back.
 *
 * The numerals are hidden from assistive technology, so each link's name is just its label
 * ("Stats"), which is also what the end-to-end tests look for.
 */
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { startsGroup, type NavPlace } from '../../lib/navigation';

const props = defineProps<{ places: readonly NavPlace[]; current: number }>();

const hovered = ref<number | null>(null);
const at = computed(() => hovered.value ?? props.current);
const markerStyle = computed(() => ({
  transform: `translateX(calc(${Math.max(at.value, 0)} * var(--place-w) + var(--place-w) / 2))`,
  opacity: at.value < 0 ? 0 : 1,
}));
</script>

<template>
  <nav class="ruler" aria-label="Places" @mouseleave="hovered = null">
    <div class="track">
      <RouterLink
        v-for="(place, i) in places"
        :key="place.key"
        :to="place.to"
        class="place"
        :class="{ here: i === current, lit: i === at }"
        :aria-current="i === current ? 'page' : undefined"
        @mouseenter="hovered = i"
        @focus="hovered = i"
        @blur="hovered = null"
      >
        <span class="numeral" aria-hidden="true">{{
          startsGroup(places, i) ? place.group : ''
        }}</span>
        <span class="label">{{ place.label }}</span>
        <span class="tick" :class="{ tall: startsGroup(places, i) }" aria-hidden="true" />
      </RouterLink>
      <span class="baseline" aria-hidden="true" />
      <span class="marker" :style="markerStyle" aria-hidden="true" />
    </div>
  </nav>
</template>

<style scoped>
.ruler {
  --place-w: 6.4rem;
  display: flex;
  justify-content: flex-end;
  align-self: stretch;
  min-width: 0;
}
@media (max-width: 760px) {
  .ruler {
    display: none;
  }
}
.track {
  position: relative;
  display: flex;
  align-items: stretch;
  /* The fine graduation along the bottom edge, every 0.6rem. */
  background-image: repeating-linear-gradient(to right, var(--ink) 0 1px, transparent 1px 0.6rem);
  background-size: 100% 5px;
  background-repeat: no-repeat;
  background-position: left bottom;
}
.place {
  position: relative;
  width: var(--place-w);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.1rem;
  padding: 0.35rem 0 0.85rem;
  text-decoration: none;
  text-align: center;
}
.numeral {
  min-height: 0.85rem;
  font-family: var(--font-body);
  font-size: 0.6rem;
  letter-spacing: 0.09em;
  color: var(--muted);
}
.label {
  font-family: var(--font-ui);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--muted);
  transition: color 0.3s var(--ease);
}
.place.lit .label,
.place.here .label {
  color: var(--ink);
}
.place:focus-visible {
  outline-offset: -2px;
}
.tick {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 1px;
  height: 0.5rem;
  background: var(--ink);
}
.tick.tall {
  height: 0.85rem;
}
.baseline {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--ink);
}
.marker {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 3px;
  height: 1.2rem;
  margin-left: -1.5px;
  background: var(--warm);
  pointer-events: none;
  transition:
    transform 0.55s var(--ease),
    opacity 0.3s var(--ease);
}
</style>
