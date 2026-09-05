<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  energy: number;
  poisonCounters: number;
  counters?: Record<string, number> | undefined;
  compact?: boolean;
}>();

const labels: Record<string, string> = {
  experience: 'XP',
  rad: 'RAD',
  poison: 'POISON',
  toxic: 'TOXIC',
};

const entries = computed(() => {
  const values = new Map<string, { key: string; label: string; value: number; kind: string }>();

  if (props.energy !== 0) {
    values.set('energy', { key: 'energy', label: 'ENERGY', value: props.energy, kind: 'energy' });
  }
  if (props.poisonCounters !== 0) {
    values.set('poison', {
      key: 'poison',
      label: 'POISON',
      value: props.poisonCounters,
      kind: 'poison',
    });
  }

  for (const [key, value] of Object.entries(props.counters ?? {})) {
    if (value === 0 || values.has(key)) continue;
    values.set(key, {
      key,
      label: labels[key] ?? key.toUpperCase(),
      value,
      kind: key,
    });
  }

  return [...values.values()];
});
</script>

<template>
  <div
    v-if="entries.length > 0"
    class="global-counters"
    :class="{ compact }"
    aria-label="Global counters"
  >
    <span
      v-for="entry in entries"
      :key="entry.key"
      class="counter-badge"
      :class="`counter-${entry.kind}`"
    >
      <strong>{{ entry.label }}</strong>
      <span>{{ entry.value }}</span>
    </span>
  </div>
</template>

<style scoped>
.global-counters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}

.counter-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0.16rem 0.42rem;
  background: var(--surface-2);
  color: var(--text);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}

.counter-badge strong {
  color: var(--muted);
  font-size: 0.55rem;
  letter-spacing: 0.06em;
}

.counter-badge > span {
  font-weight: 800;
}

.counter-energy {
  border-color: rgb(45 212 191 / 45%);
  color: #5eead4;
}

.counter-poison,
.counter-toxic {
  border-color: rgb(248 113 113 / 45%);
  color: #fca5a5;
}

.counter-experience {
  border-color: rgb(192 132 252 / 45%);
  color: #d8b4fe;
}

.compact {
  gap: 0.25rem;
}

.compact .counter-badge {
  padding: 0.12rem 0.34rem;
  font-size: 0.62rem;
}

.compact .counter-badge strong {
  font-size: 0.5rem;
}
</style>
