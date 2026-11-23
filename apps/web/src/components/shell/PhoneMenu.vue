<script setup lang="ts">
/**
 * Phones: the name is the menu (redesign plan, phase 2; `MainPhone.dc.html`). Tapping "Decktank"
 * drops a full-height sheet of the same places as the ruler, grouped, each with one line about
 * it, and the theme control at the foot. Choosing a place (the current one too, which changes no
 * route), Escape, or tapping the name again closes it.
 */
import { ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { NAV_GROUP_NAMES, startsGroup, type NavPlace } from '../../lib/navigation';
import ThemeControl from './ThemeControl.vue';

defineProps<{ places: readonly NavPlace[]; current: number }>();

const open = ref(false);
const route = useRoute();
watch(
  () => route.fullPath,
  () => {
    open.value = false;
  },
);
</script>

<template>
  <div class="phone-menu">
    <button
      type="button"
      class="brand-button"
      :aria-expanded="open"
      aria-controls="phone-places"
      @click="open = !open"
    >
      Decktank
      <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true" :class="{ flipped: open }">
        <path d="M1 1 L6 6 L11 1" fill="none" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    <nav
      v-if="open"
      id="phone-places"
      class="sheet"
      aria-label="Places"
      @keydown.esc="open = false"
    >
      <template v-for="(place, i) in places" :key="place.key">
        <div v-if="startsGroup(places, i)" class="group-head">
          <span class="group-numeral">{{ place.group }}</span>
          <span class="group-name">{{ NAV_GROUP_NAMES[place.group] }}</span>
        </div>
        <RouterLink
          :to="place.to"
          class="row"
          :class="{ here: i === current }"
          :aria-current="i === current ? 'page' : undefined"
          @click="open = false"
        >
          <span class="mark" aria-hidden="true" />
          <span class="text">
            <span class="label">{{ place.label }}</span>
            <span class="description">{{ place.description }}</span>
          </span>
          <span class="arrow" aria-hidden="true">&#8594;</span>
        </RouterLink>
      </template>
      <div class="foot">
        <ThemeControl />
      </div>
    </nav>
  </div>
</template>

<style scoped>
.phone-menu {
  display: none;
}
@media (max-width: 760px) {
  .phone-menu {
    display: contents;
  }
}
.brand-button {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 44px;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: var(--font-display);
  font-size: 1.1rem;
  letter-spacing: -0.02em;
  text-transform: uppercase;
}
.brand-button:hover:not(:disabled) {
  background: transparent;
}
.brand-button svg {
  transition: transform 0.3s var(--ease);
}
.brand-button svg.flipped {
  transform: rotate(180deg);
}
.sheet {
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  z-index: 50;
  height: calc(100vh - 100%);
  overflow: auto;
  display: flex;
  flex-direction: column;
  padding: 0.25rem 1rem 1.25rem;
  background: var(--paper-2);
  border-bottom: 1px solid var(--ink);
  animation: sheetDrop 0.35s var(--ease) both;
}
@keyframes sheetDrop {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.group-head {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 1.3rem 0 0.45rem;
  border-bottom: 1px solid var(--ink);
}
.group-numeral {
  min-width: 2.2rem;
  font-family: var(--font-display);
  font-size: 1.5rem;
  line-height: 1;
}
.group-name {
  font-family: var(--font-body);
  font-size: 0.62rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 3.6rem;
  padding: 0.5rem 0 0.5rem 2.95rem;
  border-bottom: 1px solid var(--rule);
  text-decoration: none;
  color: var(--ink);
}
.mark {
  position: absolute;
  left: 0;
  top: 0.85rem;
  bottom: 0.85rem;
  width: 3px;
}
.row.here .mark {
  background: var(--warm);
}
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.label {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.description {
  font-family: var(--font-body);
  font-size: 0.72rem;
  line-height: 1.35;
  color: var(--muted);
}
.arrow {
  font-size: 1rem;
}
.row.here .arrow {
  color: var(--warm);
}
.foot {
  margin-top: auto;
  padding-top: 1.75rem;
}
</style>
