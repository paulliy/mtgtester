<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { SavedDeckOption, SeatSource, SetupPreview, ProviderKind } from '@mtg/shared';
import { useConfirmedStart } from '../composables/useConfirmedStart';
import { PROVIDER_LABELS, controllerLabel } from '../lib/providerLabels';
import { useGameStore } from '../stores/game';
import {
  pruneRecentIds,
  readRecentIds,
  saveRecentIds,
  syncRecentDeckIds,
} from '../lib/recentSetup';

const store = useGameStore();
const PODS = [
  { id: 'constellation', name: 'Constellation pod' },
  { id: 'orbit', name: 'Orbit pod' },
  { id: 'cascade', name: 'Cascade pod' },
] as const;
const deckKind = ref<'pool' | 'saved' | 'import'>('pool');
const savedId = ref('');
const importText = ref('');
const podId = ref<string>('constellation');
const provider = ref<ProviderKind>('random');
const seed = ref('');
const saved = ref<SavedDeckOption[]>([]);
const persistence = ref(false);
const loading = ref(false);
const error = ref('');
const preview = ref<SetupPreview | null>(null);
const { starting, startErrors, begin, clearStartErrors } = useConfirmedStart();
const recentDecks = ref<string[]>(readRecentIds('mtg-recent-deck-ids'));
const recentPods = ref<string[]>(readRecentIds('mtg-recent-pod-ids'));

onMounted(async () => {
  try {
    const response = await fetch('/api/saved-decks');
    if (!response.ok) throw new Error('Could not load saved decks.');
    const data = (await response.json()) as { enabled: boolean; decks: SavedDeckOption[] };
    persistence.value = data.enabled;
    saved.value = data.decks;
    // Only a database-backed server can say which saved decks still exist; without one the deck
    // recents are left exactly as stored. Pods are a local list, so they are always prunable.
    recentDecks.value = syncRecentDeckIds('mtg-recent-deck-ids', recentDecks.value, {
      enabled: data.enabled,
      available: data.decks.map((deck) => deck.snapshotId),
    });
    recentPods.value = pruneRecentIds(
      recentPods.value,
      PODS.map((pod) => pod.id),
    );
    saveRecentIds('mtg-recent-pod-ids', recentPods.value);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
});

watch([deckKind, savedId, importText, podId, provider, seed], () => {
  preview.value = null;
  clearStartErrors();
});

const orderedDecks = computed(() =>
  [...saved.value].sort((a, b) => {
    const ai = recentDecks.value.indexOf(a.snapshotId);
    const bi = recentDecks.value.indexOf(b.snapshotId);
    return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
  }),
);
const orderedPods = computed(() =>
  [...PODS].sort((a, b) => {
    const ai = recentPods.value.indexOf(a.id);
    const bi = recentPods.value.indexOf(b.id);
    return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
  }),
);
const canPreview = computed(
  () =>
    deckKind.value === 'pool' ||
    (persistence.value &&
      (deckKind.value === 'saved' ? savedId.value !== '' : importText.value.trim() !== '')),
);

function selections(): SeatSource[] {
  const player: SeatSource =
    deckKind.value === 'saved'
      ? { kind: 'snapshot', snapshotId: savedId.value }
      : deckKind.value === 'import'
        ? /^https?:\/\//i.test(importText.value.trim())
          ? { kind: 'url', url: importText.value.trim() }
          : { kind: 'plaintext', text: importText.value.trim() }
        : { kind: 'pool' };
  return [
    player,
    ...[2, 3, 4].map((seat) => ({ kind: 'pool' as const, seed: `phase9-${podId.value}-P${seat}` })),
  ];
}

async function inspect(): Promise<void> {
  loading.value = true;
  error.value = '';
  preview.value = null;
  try {
    const response = await fetch('/api/setup-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seats: selections(),
        seed: seed.value.trim(),
        providerKind: provider.value,
        gameMode: 'singlePlayer',
        humanSeat: 'P1',
      }),
    });
    const result = (await response.json()) as SetupPreview & { message?: string };
    if (!response.ok) throw new Error(result.message ?? 'Preview failed.');
    preview.value = result;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

function play(): void {
  const ready = preview.value;
  if (!ready || ready.blockers.length > 0) return;
  // The pod is handed to the store rather than written here, so it joins the recents only if the
  // server answers `gameStarted` — the same rule the human deck already follows, which is
  // remembered from the snapshot ID that answer returns. Writing it now would record a pod that
  // a rejected or dropped start never played.
  begin(() =>
    store.startGame(
      selections(),
      provider.value,
      ready.seed,
      'singlePlayer',
      'P1',
      false,
      ready.previewId,
      podId.value,
    ),
  );
}
</script>

<template>
  <section class="player-flow panel" aria-labelledby="play-my-deck-title">
    <h2 id="play-my-deck-title">Play my deck</h2>
    <p>Choose your deck, a named bot pod, then preview the matchup.</p>
    <div class="fields">
      <fieldset>
        <legend>Your deck</legend>
        <label
          ><input v-model="deckKind" type="radio" value="pool" /> Generated supported deck</label
        >
        <label
          ><input v-model="deckKind" type="radio" value="saved" :disabled="!persistence" /> Saved
          deck</label
        >
        <label
          ><input v-model="deckKind" type="radio" value="import" :disabled="!persistence" /> Import
          deck</label
        >
        <p v-if="!persistence" class="hint">
          Saved and imported decks are disabled without a database. Supported pool play remains
          available.
        </p>
        <label v-if="deckKind === 'saved'" class="vertical"
          >Saved snapshot
          <select v-model="savedId">
            <option value="">Choose a deck</option>
            <option v-for="deck in orderedDecks" :key="deck.snapshotId" :value="deck.snapshotId">
              {{ deck.name }} — {{ deck.commanderNames.join(' & ') }}
            </option>
          </select>
        </label>
        <label v-if="deckKind === 'import'" class="vertical"
          >Deck URL or plaintext decklist
          <textarea v-model="importText" rows="4" placeholder="Paste a deck URL or list"></textarea>
        </label>
      </fieldset>
      <fieldset>
        <legend>Bot opponents</legend>
        <label class="vertical"
          >Generated pod
          <select v-model="podId">
            <option v-for="pod in orderedPods" :key="pod.id" :value="pod.id">{{ pod.name }}</option>
          </select>
        </label>
        <label class="vertical"
          >Bot controller
          <select v-model="provider">
            <option value="random">{{ PROVIDER_LABELS.random }}</option>
            <option value="ai">{{ PROVIDER_LABELS.ai }}</option>
          </select>
        </label>
        <label class="vertical"
          >Replay seed (optional)
          <input v-model="seed" placeholder="Fresh seed" />
        </label>
      </fieldset>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="button" :disabled="!canPreview || loading" @click="inspect">
      {{ loading ? 'Checking…' : 'Preview matchup' }}
    </button>
    <div v-if="preview" class="matchup" aria-label="Matchup preview">
      <p><strong>Seed:</strong> {{ preview.seed }}</p>
      <ul>
        <li v-for="seat in preview.seats" :key="seat.seat">
          <strong>{{ seat.seat }} {{ controllerLabel(seat.controller) }}</strong> —
          <template v-if="seat.modeled">
            {{ seat.commanderNames.join(' & ') }} · {{ seat.colorIdentity.join('') || 'C' }} ·
            {{ seat.archetypeTag || 'Unknown archetype' }} · Fully modeled
          </template>
          <template v-else>
            {{
              seat.seat === 'P1'
                ? 'Your deck is blocked. See the reason below.'
                : 'Opponent deck is blocked. See the reason below.'
            }}
          </template>
        </li>
      </ul>
      <ul v-if="preview.blockers.length" role="alert">
        <li v-for="blocker in preview.blockers" :key="blocker">{{ blocker }}</li>
      </ul>
      <div v-if="startErrors.length" class="start-errors" role="alert">
        <strong>The game did not start.</strong>
        <ul>
          <li v-for="(message, index) in startErrors" :key="index">
            {{ message }}
          </li>
        </ul>
      </div>
      <button type="button" :disabled="preview.blockers.length > 0 || starting" @click="play">
        {{ starting ? 'Starting…' : 'Play' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 1rem;
}
h2 {
  margin: 0 0 0.4rem;
}
p {
  color: var(--muted);
}
.fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.8rem;
  margin: 0.8rem 0;
}
fieldset {
  border: 1px solid var(--line);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}
legend {
  font-weight: 700;
}
.vertical {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
select,
textarea,
input:not([type='radio']) {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem;
  background: var(--surface-2);
  color: inherit;
  border: 1px solid var(--line);
  border-radius: 4px;
}
button {
  padding: 0.55rem 0.8rem;
  border-radius: 5px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #07121f;
  cursor: pointer;
  font-weight: 700;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.matchup {
  margin-top: 1rem;
}
.matchup ul {
  padding-left: 1.2rem;
  line-height: 1.8;
}
.start-errors {
  margin: 0 0 0.8rem;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--danger);
  border-radius: 6px;
  color: var(--danger);
}
.start-errors ul {
  margin: 0.3rem 0 0;
  line-height: 1.5;
}
@media (max-width: 600px) {
  .fields {
    grid-template-columns: 1fr;
  }
}
</style>
