<script setup lang="ts">
import { onMounted, ref } from 'vue';

interface DeckStatistic {
  deckSnapshotId: string;
  name: string;
  commanders: string[];
  colorIdentity: string[];
  archetypeTag: string;
  gamesPlayed: number;
  wins: number;
  winRate: number;
  averageFinish: number | null;
  averageGameLength: number | null;
  averageMulligans: number;
  mulliganDistribution: Array<{ mulligans: number; games: number }>;
  eliminationCauses: Array<{ reason: string; count: number }>;
  lossesTo: Array<{ commanders: string[]; colorIdentity: string[]; archetypeTag: string; count: number }>;
  manaFloodRate: number | null;
  manaDroughtRate: number | null;
}

const decks = ref<DeckStatistic[]>([]);
const batchId = new URLSearchParams(window.location.search).get('batchId');
const error = ref<string | null>(null);
const loading = ref(true);

function percent(value: number | null): string {
  if (value === null) return 'Unavailable';
  return `${Math.round(value * 100)}%`;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await fetch(batchId === null ? '/api/stats' : `/api/stats?batchId=${encodeURIComponent(batchId)}`);
    if (!response.ok) throw new Error((await response.json() as { message?: string }).message ?? 'Could not load stats.');
    decks.value = (await response.json() as { decks: DeckStatistic[] }).decks;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="stats">
    <header>
      <div>
        <h1>{{ batchId === null ? 'Deck statistics' : 'Batch deck statistics' }}</h1>
        <p>Finished games only.</p>
      </div>
      <button @click="load">Refresh</button>
    </header>

    <p v-if="loading">Loading historical results…</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <p v-else-if="decks.length === 0">No finished recorded games yet.</p>

    <article v-for="deck in decks" :key="deck.deckSnapshotId" class="deck">
      <header>
        <div>
          <h2>{{ deck.name }}</h2>
          <p>{{ deck.commanders.join(' / ') }} · {{ deck.colorIdentity.join('') || 'Colorless' }} · {{ deck.archetypeTag }}</p>
        </div>
        <strong>{{ percent(deck.winRate) }} wins</strong>
      </header>
      <dl class="summary">
        <div><dt>Games</dt><dd>{{ deck.gamesPlayed }}</dd></div>
        <div><dt>Wins</dt><dd>{{ deck.wins }}</dd></div>
        <div><dt>Avg. finish</dt><dd>{{ deck.averageFinish?.toFixed(2) ?? '—' }}</dd></div>
        <div><dt>Avg. length</dt><dd>{{ deck.averageGameLength?.toFixed(1) ?? '—' }} turns</dd></div>
        <div><dt>Avg. mulligans</dt><dd>{{ deck.averageMulligans.toFixed(2) }}</dd></div>
        <div><dt>Flood rate</dt><dd>{{ percent(deck.manaFloodRate) }}</dd></div>
        <div><dt>Drought rate</dt><dd>{{ percent(deck.manaDroughtRate) }}</dd></div>
      </dl>
      <div class="breakdowns">
        <section><h3>Elimination causes</h3><p v-if="deck.eliminationCauses.length === 0">No losses recorded.</p><ul v-else><li v-for="entry in deck.eliminationCauses" :key="entry.reason">{{ entry.reason }}: {{ entry.count }}</li></ul></section>
        <section><h3>Who beats me</h3><p v-if="deck.lossesTo.length === 0">No attributable eliminations recorded.</p><ul v-else><li v-for="entry in deck.lossesTo" :key="`${entry.commanders.join()}${entry.archetypeTag}`">{{ entry.commanders.join(' / ') }} ({{ entry.colorIdentity.join('') }}, {{ entry.archetypeTag }}): {{ entry.count }}</li></ul></section>
        <section><h3>Mulligans</h3><p>{{ deck.mulliganDistribution.map((item) => `${item.mulligans}: ${item.games}`).join(' · ') || '—' }}</p></section>
      </div>
    </article>

    <aside class="method"><strong>Mana rates unavailable.</strong> Earlier recordings lack the draw history and end-of-turn information needed to calculate reliable flood and drought rates.</aside>
  </section>
</template>

<style scoped>
.stats { max-width: 1100px; margin: 0 auto; padding: 1rem; }
header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
h1, h2, h3, p { margin: 0; }
p { color: var(--muted); margin-top: .25rem; }
.deck { border: 1px solid var(--line); background: var(--surface); padding: .8rem; margin-top: .8rem; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(115px, 1fr)); gap: .5rem; margin: .8rem 0; }
.summary div { background: var(--surface-2); padding: .45rem; }
dt { color: var(--muted); font-size: .78rem; } dd { margin: .15rem 0 0; font-weight: 600; }
.breakdowns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .8rem; font-size: .86rem; }
h3 { font-size: .9rem; } ul { margin: .35rem 0 0; padding-left: 1.1rem; }.error { color: var(--danger); }.method { margin-top: 1rem; color: var(--muted); font-size: .85rem; }
@media (max-width: 700px) { .breakdowns { grid-template-columns: 1fr; } }
</style>
