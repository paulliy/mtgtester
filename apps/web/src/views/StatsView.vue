<script setup lang="ts">
import PageTitle from '../components/shell/PageTitle.vue';
import PageFoot from '../components/shell/PageFoot.vue';
import { computed, onMounted, ref } from 'vue';

interface DeckStatistic {
  deckSnapshotId: string;
  name: string;
  generated: boolean;
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
  eliminationCauses: Array<{ reason: string; label: string; count: number }>;
  lossesTo: Array<{
    commanders: string[];
    colorIdentity: string[];
    archetypeTag: string;
    count: number;
  }>;
  manaFloodRate: number | null;
  manaDroughtRate: number | null;
}

const decks = ref<DeckStatistic[]>([]);
const batchId = new URLSearchParams(window.location.search).get('batchId');
const error = ref<string | null>(null);
const loading = ref(true);

/**
 * An unnamed deck (every generated one) comes back named by its snapshot id — a UUID that tells
 * a reader nothing. Head those with their commanders instead.
 */
function isUnnamed(deck: DeckStatistic): boolean {
  return deck.name === deck.deckSnapshotId || deck.name.trim() === '';
}
function deckHeading(deck: DeckStatistic): string {
  if (!isUnnamed(deck)) return deck.name;
  return deck.commanders.length > 0 ? deck.commanders.join(' / ') : 'Unnamed deck';
}

/**
 * Every pool-generated game makes a new deck with its own random list, so a long history is
 * mostly one-game generated entries that bury the decks a player saved or imported. Show those
 * first and fold the generated ones away; they stay distinct because their lists differ.
 */
const sections = computed(() => {
  const own = decks.value.filter((deck) => !deck.generated);
  const generated = decks.value.filter((deck) => deck.generated);
  return [
    { key: 'own', title: 'Saved and imported decks', decks: own, collapsible: false, open: true },
    {
      key: 'generated',
      title: `Generated decks (${generated.length})`,
      decks: generated,
      collapsible: true,
      open: own.length === 0,
    },
  ].filter((section) => section.decks.length > 0);
});

function percent(value: number | null): string {
  if (value === null) return 'Unavailable';
  return `${Math.round(value * 100)}%`;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await fetch(
      batchId === null ? '/api/stats' : `/api/stats?batchId=${encodeURIComponent(batchId)}`,
    );
    if (!response.ok)
      throw new Error(
        ((await response.json()) as { message?: string }).message ?? 'Could not load stats.',
      );
    decks.value = ((await response.json()) as { decks: DeckStatistic[] }).decks;
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
        <PageTitle place="II. Records · a. Stats">{{
          batchId === null ? 'Deck statistics' : 'Batch deck statistics'
        }}</PageTitle>
        <p>Finished games only.</p>
      </div>
      <button @click="load">Refresh</button>
    </header>

    <p v-if="loading">Loading historical results…</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <p v-else-if="decks.length === 0">No finished recorded games yet.</p>

    <component
      :is="section.collapsible ? 'details' : 'section'"
      v-for="section in sections"
      :key="section.key"
      class="deck-section"
      :open="section.open"
    >
      <summary v-if="section.collapsible">{{ section.title }}</summary>
      <h2 v-else class="section-title">{{ section.title }}</h2>
      <article v-for="deck in section.decks" :key="deck.deckSnapshotId" class="deck">
        <header>
          <div>
            <h2>{{ deckHeading(deck) }}</h2>
            <p>
              <template v-if="!isUnnamed(deck)">{{ deck.commanders.join(' / ') }} · </template>
              {{ deck.colorIdentity.join('') || 'Colorless' }} · {{ deck.archetypeTag }}
            </p>
          </div>
          <strong>{{ percent(deck.winRate) }} wins</strong>
        </header>
        <dl class="summary">
          <div>
            <dt>Games</dt>
            <dd>{{ deck.gamesPlayed }}</dd>
          </div>
          <div>
            <dt>Wins</dt>
            <dd>{{ deck.wins }}</dd>
          </div>
          <div>
            <dt>Avg. finish</dt>
            <dd>{{ deck.averageFinish?.toFixed(2) ?? '—' }}</dd>
          </div>
          <div>
            <dt>Avg. length</dt>
            <dd>{{ deck.averageGameLength?.toFixed(1) ?? '—' }} turns</dd>
          </div>
          <div>
            <dt>Avg. mulligans</dt>
            <dd>{{ deck.averageMulligans.toFixed(2) }}</dd>
          </div>
          <!-- Legacy recordings cannot support either rate (see the note below); one tile says so. -->
          <div v-if="deck.manaFloodRate === null && deck.manaDroughtRate === null">
            <dt>Flood / drought</dt>
            <dd>Unavailable</dd>
          </div>
          <template v-else>
            <div>
              <dt>Flood rate</dt>
              <dd>{{ percent(deck.manaFloodRate) }}</dd>
            </div>
            <div>
              <dt>Drought rate</dt>
              <dd>{{ percent(deck.manaDroughtRate) }}</dd>
            </div>
          </template>
        </dl>
        <div class="breakdowns">
          <section>
            <h3>Elimination causes</h3>
            <p v-if="deck.eliminationCauses.length === 0">No losses recorded.</p>
            <ul v-else>
              <li v-for="entry in deck.eliminationCauses" :key="entry.reason">
                {{ entry.label }}: {{ entry.count }}
              </li>
            </ul>
          </section>
          <section>
            <h3>Who beats me</h3>
            <p v-if="deck.lossesTo.length === 0">No attributable eliminations recorded.</p>
            <ul v-else>
              <li
                v-for="entry in deck.lossesTo"
                :key="`${entry.commanders.join()}${entry.archetypeTag}`"
              >
                {{ entry.commanders.join(' / ') }} ({{ entry.colorIdentity.join('') }},
                {{ entry.archetypeTag }}): {{ entry.count }}
              </li>
            </ul>
          </section>
          <section>
            <h3>Mulligans</h3>
            <p>
              {{
                deck.mulliganDistribution
                  .map((item) => `${item.mulligans}: ${item.games}`)
                  .join(' · ') || '—'
              }}
            </p>
          </section>
        </div>
      </article>
    </component>

    <aside class="method">
      <strong>Mana rates unavailable.</strong> Flood and drought rates are not calculated for any
      game yet, including new ones: the recorded turn observations do not capture what each player
      could actually afford, so a percentage would be a guess.
    </aside>
    <PageFoot place="II. Records · a. Stats" />
  </section>
</template>

<style scoped>
.stats {
  max-width: 1100px;
  margin: 0 auto;
  padding: 1rem;
}
header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 1rem;
}
h1,
h2,
h3,
p {
  margin: 0;
}
p {
  color: var(--muted);
  margin-top: 0.25rem;
}
.deck-section {
  margin-top: 1rem;
}
.deck-section > summary,
.section-title {
  font-size: 1rem;
  font-weight: 700;
}
.deck-section > summary {
  cursor: pointer;
}
.deck {
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 0.8rem;
  margin-top: 0.8rem;
}
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(115px, 1fr));
  gap: 0.5rem;
  margin: 0.8rem 0;
}
.summary div {
  background: var(--surface-2);
  padding: 0.45rem;
}
dt {
  color: var(--muted);
  font-size: 0.78rem;
}
dd {
  margin: 0.15rem 0 0;
  font-weight: 600;
}
.breakdowns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.8rem;
  font-size: 0.86rem;
}
h3 {
  font-size: 0.9rem;
}
ul {
  margin: 0.35rem 0 0;
  padding-left: 1.1rem;
}
.error {
  color: var(--danger);
}
.method {
  margin-top: 1rem;
  color: var(--muted);
  font-size: 0.85rem;
}
@media (max-width: 700px) {
  .breakdowns {
    grid-template-columns: 1fr;
  }
}
</style>
