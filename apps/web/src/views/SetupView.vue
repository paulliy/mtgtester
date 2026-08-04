<script setup lang="ts">
/**
 * The deck setup screen (brief §10.2, §8).
 *
 * Two paths, and the default is deliberately the generated one. The engine halts on any
 * unmodeled card, so a real decklist is all-or-nothing and usually nothing (ADR 0009) — a
 * screen offering only four Moxfield URLs would produce a halt on turn one for essentially
 * every deck a user owns. Imported decks are still supported and are pre-flighted, so the
 * blocking card names come back here rather than as a mid-game halt.
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Color, GameMode, ProviderKind, SeatSource } from '@mtg/shared';
import { useGameStore } from '../stores/game';

const store = useGameStore();
const router = useRouter();

const SEATS = 4;

type Mode = 'pool' | 'known' | 'import';

const mode = ref<Mode>('pool');
const gameMode = ref<GameMode>('spectator');
const humanSeat = ref('P1');
const advancedPodSetup = ref(false);
const providerKind = ref<ProviderKind>('random');
/**
 * Post-game AI commentary (ADR 0022 §7). Off by default and only meaningful with AI bots — it is
 * the one option on this screen that spends budget *after* the game is already over, so it is an
 * explicit per-game choice rather than a server setting someone has to remember they left on.
 */
const reflectionEnabled = ref(false);
const seed = ref('');
const inputs = ref<string[]>(Array.from({ length: SEATS }, () => ''));
const tags = ref<string[]>(Array.from({ length: SEATS }, () => ''));

/**
 * Decks that have already been imported and measured for engine model coverage (`bun run
 * coverage`) — a "known-good-ish" alternative to a blind Moxfield paste, since each option's
 * modeled fraction is shown up front rather than discovered as a mid-setup halt (ADR 0009).
 */
interface KnownDeck {
  slug: string;
  name: string;
  commanderNames: string[];
  colorIdentity: Color[];
  uniqueCards: number;
  modeledCards: number;
  /** Inferred archetype (ADR 0022 §5) — what the deck does, which the name rarely says. */
  archetypeTag: string;
  text: string;
}

const knownDecks = ref<KnownDeck[]>([]);
const knownDecksError = ref<string | null>(null);
const selectedKnown = ref<string[]>(Array.from({ length: SEATS }, () => ''));

onMounted(async () => {
  try {
    const response = await fetch('/api/known-decks');
    if (!response.ok)
      throw new Error(
        ((await response.json()) as { message?: string }).message ?? 'Could not load known decks.',
      );
    knownDecks.value = ((await response.json()) as { decks: KnownDeck[] }).decks;
  } catch (reason) {
    knownDecksError.value = reason instanceof Error ? reason.message : String(reason);
  }
});

function pickKnown(index: number, slug: string): void {
  selectedKnown.value[index] = slug;
  if (slug === '') return;
  const deck = knownDecks.value.find((d) => d.slug === slug);
  if (deck === undefined) return;
  inputs.value[index] = deck.text;
}

const activeSeatIndex = computed(() =>
  gameMode.value === 'singlePlayer' ? Number(humanSeat.value.slice(1)) - 1 : 0,
);

const displayedSeats = computed(() =>
  advancedPodSetup.value
    ? Array.from({ length: SEATS }, (_, i) => i + 1)
    : [activeSeatIndex.value + 1],
);

const canStart = computed(() =>
  mode.value === 'pool'
    ? true
    : mode.value === 'known'
      ? displayedSeats.value.every((index) => selectedKnown.value[index - 1] !== '')
    : !advancedPodSetup.value
      ? (inputs.value[activeSeatIndex.value]?.trim().length ?? 0) > 0
      : inputs.value.every((v) => v.trim().length > 0),
);

function sourceFor(index: number): SeatSource {
  if (mode.value === 'pool') return { kind: 'pool' };
  if (!advancedPodSetup.value && index !== activeSeatIndex.value) {
    return { kind: 'pool' };
  }
  const raw = inputs.value[index]?.trim() ?? '';
  const tag = tags.value[index]?.trim() ?? '';
  const isUrl = /^https?:\/\//i.test(raw);
  if (isUrl) return { kind: 'url', url: raw, ...(tag !== '' && { archetypeTag: tag }) };
  return { kind: 'plaintext', text: raw, ...(tag !== '' && { archetypeTag: tag }) };
}

function start(): void {
  const sources = Array.from({ length: SEATS }, (_, i) => sourceFor(i));
  store.startGame(
    sources,
    providerKind.value,
    seed.value.trim(),
    gameMode.value,
    humanSeat.value,
    reflectionEnabled.value,
  );
  void router.push('/game');
}
</script>

<template>
  <div class="setup">
    <header class="setup-header">
      <div>
        <p class="eyebrow">Commander simulator</p>
        <h1>New game</h1>
        <p class="lede">Watch four bots simulate Commander, or play one seat against three bots.</p>
      </div>
      <span class="header-mark" aria-hidden="true">SETUP</span>
    </header>

    <section class="panel" aria-labelledby="game-mode-label">
      <h2 id="game-mode-label" class="panel-label">Game mode</h2>
      <div class="choice-grid">
        <label class="choice-card" :class="{ selected: gameMode === 'spectator' }">
          <input v-model="gameMode" class="choice-input" type="radio" value="spectator" />
          <span class="choice-indicator" aria-hidden="true"></span>
          <span class="choice-copy">
            <strong>Spectator simulation</strong>
            <em>Four bots play while you watch, scrub, and inspect every hand.</em>
          </span>
        </label>
        <label class="choice-card" :class="{ selected: gameMode === 'singlePlayer' }">
          <input v-model="gameMode" class="choice-input" type="radio" value="singlePlayer" />
          <span class="choice-indicator" aria-hidden="true"></span>
          <span class="choice-copy">
            <strong>Play against three bots</strong>
            <em>Your choices pause indefinitely; opponents' hidden cards stay hidden.</em>
          </span>
        </label>
      </div>

      <div v-if="gameMode === 'singlePlayer'" class="seat-picker">
        <span class="field-label">Your seat</span>
        <div class="seat-options" role="radiogroup" aria-label="Your seat">
          <button
            v-for="index in SEATS"
            :key="index"
            type="button"
            class="seat-pill"
            :class="{ active: humanSeat === `P${index}` }"
            :aria-checked="humanSeat === `P${index}`"
            role="radio"
            @click="humanSeat = `P${index}`"
          >
            P{{ index }}
          </button>
        </div>
      </div>
    </section>

    <section class="panel" aria-labelledby="decks-label">
      <h2 id="decks-label" class="panel-label">Decks</h2>
      <div class="choice-grid">
        <label class="choice-card" :class="{ selected: mode === 'pool' }">
          <input v-model="mode" class="choice-input" type="radio" value="pool" />
          <span class="choice-indicator" aria-hidden="true"></span>
          <span class="choice-copy">
            <strong>Generate from the engine-supported pool</strong>
            <em>Always playable. Generated decks use cards the engine can model reliably.</em>
          </span>
        </label>
        <label class="choice-card" :class="{ selected: mode === 'import' }">
          <input v-model="mode" class="choice-input" type="radio" value="import" />
          <span class="choice-indicator" aria-hidden="true"></span>
          <span class="choice-copy">
            <strong>Import decklists</strong>
            <em>Paste a Moxfield / Archidekt URL or a plaintext decklist to pre-flight.</em>
          </span>
        </label>
        <label class="choice-card" :class="{ selected: mode === 'known' }">
          <input v-model="mode" class="choice-input" type="radio" value="known" />
          <span class="choice-indicator" aria-hidden="true"></span>
          <span class="choice-copy">
            <strong>Choose a modeled deck</strong>
            <em>Start with a committed deck whose unique cards are fully modeled by the engine.</em>
          </span>
        </label>
      </div>

      <div v-if="mode === 'known'" class="import-panel known-panel">
        <p v-if="knownDecksError !== null" class="fetch-error">
          Modeled decks unavailable: {{ knownDecksError }}
        </p>
        <p v-else class="hint">
          Choose a modeled deck for {{ advancedPodSetup ? 'each seat' : 'your seat' }}. The other
          seats use generated, engine-supported opponents unless you enable all four decks.
        </p>
        <div v-for="index in displayedSeats" :key="index" class="deck-row">
          <span class="seat-badge">P{{ index }}</span>
          <div class="deck-inputs">
            <span class="field-label">Modeled deck</span>
            <div v-if="knownDecks.length > 0" class="known-decks">
              <button
                v-for="deck in knownDecks"
                :key="deck.slug"
                type="button"
                class="known-deck"
                :class="{ selected: selectedKnown[index - 1] === deck.slug }"
                :aria-pressed="selectedKnown[index - 1] === deck.slug"
                @click="pickKnown(index - 1, deck.slug)"
              >
                <span class="deck-avatar" aria-hidden="true">{{
                  deck.name.slice(0, 1).toUpperCase()
                }}</span>
                <span class="deck-chip-copy">
                  <span class="deck-chip-name">{{ deck.name }}</span>
                  <span class="deck-chip-meta">
                    <span class="deck-chip-archetype">{{ deck.archetypeTag }}</span>
                    {{ deck.modeledCards }}/{{ deck.uniqueCards }} modeled
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>
        <p v-if="knownDecks.length === 0 && knownDecksError === null" class="hint">
          Loading modeled decks...
        </p>
        <label class="advanced-pod">
          <input v-model="advancedPodSetup" type="checkbox" />
          <span>Choose all four decks instead</span>
        </label>
      </div>

      <div v-if="mode === 'import'" class="import-panel">
        <p v-if="!advancedPodSetup" class="hint">
          Import your deck; the other three seats use generated, engine-supported opponents.
        </p>
        <p v-if="knownDecksError !== null" class="fetch-error">
          Known decks unavailable: {{ knownDecksError }}
        </p>

        <div v-for="index in displayedSeats" :key="index" class="deck-row">
          <span class="seat-badge">P{{ index }}</span>
          <div class="deck-inputs">
            <span v-if="knownDecks.length > 0" class="field-label">Known deck quick picks</span>
            <div v-if="knownDecks.length > 0" class="known-decks">
              <button
                v-for="deck in knownDecks"
                :key="deck.slug"
                type="button"
                class="known-deck"
                :class="{ selected: selectedKnown[index - 1] === deck.slug }"
                :aria-pressed="selectedKnown[index - 1] === deck.slug"
                @click="pickKnown(index - 1, deck.slug)"
              >
                <span class="deck-avatar" aria-hidden="true">{{
                  deck.name.slice(0, 1).toUpperCase()
                }}</span>
                <span class="deck-chip-copy">
                  <span class="deck-chip-name">{{ deck.name }}</span>
                  <span class="deck-chip-meta">
                    <span class="deck-chip-archetype">{{ deck.archetypeTag }}</span>
                    {{ deck.modeledCards }}/{{ deck.uniqueCards }} modeled
                  </span>
                </span>
              </button>
            </div>
            <textarea
              v-model="inputs[index - 1]"
              class="deck-textarea"
              rows="3"
              placeholder="https://moxfield.com/decks/… or a pasted decklist"
              @input="selectedKnown[index - 1] = ''"
            ></textarea>
          </div>
          <label class="tag-field">
            <span>Archetype tag</span>
            <!-- Leaving this blank is the normal path: the server classifies the resolved list
                 (ADR 0022 §5). Anything typed here wins outright and is never overwritten. -->
            <input
              v-model="tags[index - 1]"
              type="text"
              placeholder="auto-detected if blank"
              title="Leave blank to have the archetype inferred from the decklist."
            />
          </label>
        </div>

        <label class="advanced-pod">
          <input v-model="advancedPodSetup" type="checkbox" />
          <span>Choose all four decks instead</span>
        </label>
      </div>
    </section>

    <section class="panel" aria-labelledby="players-label">
      <h2 id="players-label" class="panel-label">
        {{ gameMode === 'singlePlayer' ? 'Bot opponents' : 'Players' }}
      </h2>
      <div class="choice-grid">
        <label class="choice-card" :class="{ selected: providerKind === 'random' }">
          <input v-model="providerKind" class="choice-input" type="radio" value="random" />
          <span class="choice-indicator" aria-hidden="true"></span>
          <span class="choice-copy">
            <strong>Random bots</strong>
            <em>Fast, free, and fully seeded. Best for learning the controls or a quick game.</em>
          </span>
        </label>
        <label class="choice-card" :class="{ selected: providerKind === 'ai' }">
          <input v-model="providerKind" class="choice-input" type="radio" value="ai" />
          <span class="choice-indicator" aria-hidden="true"></span>
          <span class="choice-copy">
            <strong>AI bots</strong>
            <em>Uses strategic bot decisions and may spend API budget.</em>
          </span>
        </label>
      </div>

      <div v-if="providerKind === 'ai'" class="extra-option">
        <label class="advanced-pod">
          <input v-model="reflectionEnabled" type="checkbox" />
          <span>Post-game commentary</span>
        </label>
        <p class="hint">
          After the game ends, each bot reviews its own play — what it was trying to do, the turns
          it got wrong, and who it should have treated as the threat. Costs one extra call per bot,
          spent only once the game is already over.
        </p>
      </div>
    </section>

    <section class="panel" aria-labelledby="seed-label">
      <h2 id="seed-label" class="panel-label">
        Replay seed <span class="optional">Optional</span>
      </h2>
      <input
        v-model="seed"
        class="seed-input"
        type="text"
        placeholder="leave blank for a fresh seed"
      />
      <p class="hint">
        Leave this blank for a fresh game. Use a seed when you want to repeat a known shuffle; AI
        decisions may still vary.
      </p>
    </section>

    <div v-if="store.errors.length > 0" class="errors">
      <h3>Setup failed</h3>
      <ul>
        <li v-for="(error, index) in store.errors" :key="index">{{ error }}</li>
      </ul>
    </div>

    <div class="actions">
      <button type="button" class="primary" :disabled="!canStart" @click="start">
        <span>Start game</span>
        <span aria-hidden="true" class="button-arrow">→</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.setup {
  max-width: 760px;
  margin: 0 auto;
  padding: 1.25rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  font-size: 13px;
}
.setup-header,
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.setup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.1rem;
}
.eyebrow,
.panel-label,
.field-label,
.tag-field span {
  text-transform: uppercase;
  letter-spacing: 0.11em;
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
}
.eyebrow {
  margin: 0 0 0.35rem;
}
h1,
h2,
h3,
p {
  margin: 0;
}
.setup-header h1 {
  font-size: 1.5rem;
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.lede {
  margin-top: 0.4rem;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
}
.header-mark {
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  padding: 0.4rem 0.5rem;
}
.panel {
  padding: 0.95rem 1.1rem 1.1rem;
}
.panel-label {
  margin-bottom: 0.7rem;
}
.choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.55rem;
}
.choice-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  min-height: 76px;
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-2);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}
.choice-card:hover {
  border-color: rgb(96 165 250 / 0.55);
}
.choice-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgb(96 165 250 / 0.35);
}
.choice-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.choice-card:focus-within {
  outline: 2px solid rgb(96 165 250 / 0.45);
  outline-offset: 2px;
}
.choice-indicator {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  margin-top: 0.1rem;
  border: 1px solid var(--muted);
  border-radius: 50%;
  background: transparent;
}
.choice-card.selected .choice-indicator {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: 0 0 0 3px rgb(96 165 250 / 0.12);
}
.choice-copy {
  display: flex;
  flex-direction: column;
  gap: 0.28rem;
  min-width: 0;
}
.choice-copy strong {
  font-size: 12.5px;
  line-height: 1.25;
}
.choice-copy em {
  color: var(--muted);
  font-size: 11px;
  font-style: normal;
  line-height: 1.42;
}
.seat-picker {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  margin-top: 0.8rem;
  padding-top: 0.8rem;
  border-top: 1px solid var(--line);
}
.seat-options {
  display: flex;
  gap: 0.35rem;
}
.seat-pill {
  min-width: 2.15rem;
  border-radius: 999px;
  padding: 0.3rem 0.55rem;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
}
.seat-pill.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}
.import-panel {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  margin-top: 0.8rem;
  padding-top: 0.8rem;
  border-top: 1px solid var(--line);
}
.hint {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
}
.fetch-error {
  border-left: 2px solid var(--danger);
  padding: 0.25rem 0.5rem;
  color: var(--danger);
  font-size: 11px;
}
.deck-row {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) 9.5rem;
  gap: 0.65rem;
  align-items: start;
}
.seat-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid rgb(96 165 250 / 0.35);
  border-radius: 5px;
  background: rgb(96 165 250 / 0.1);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}
.deck-inputs {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.known-decks {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
  gap: 0.4rem;
}
.known-deck {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.45rem;
  text-align: left;
  border-radius: 6px;
}
.known-deck.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgb(96 165 250 / 0.35);
}
.deck-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  flex: 0 0 1.5rem;
  border-radius: 4px;
  background: rgb(96 165 250 / 0.12);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}
.deck-chip-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 0.1rem;
}
.deck-chip-name,
.deck-chip-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.deck-chip-name {
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
}
.deck-chip-meta {
  color: var(--muted);
  font-size: 10px;
}
/* The archetype answers "what does this deck do", which a commander name rarely does — so it
   leads the meta line and the modeled count trails it. */
.deck-chip-archetype {
  color: var(--accent);
  text-transform: capitalize;
}
.deck-chip-archetype::after {
  content: ' · ';
  color: var(--muted);
}
.deck-textarea,
.seed-input,
.tag-field input {
  background: var(--surface-2);
  border-radius: 5px;
  font-size: 11.5px;
}
.deck-textarea {
  min-height: 4.2rem;
  resize: vertical;
  line-height: 1.4;
}
.tag-field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding-top: 0.1rem;
}
.tag-field span {
  font-size: 9px;
  letter-spacing: 0.08em;
}
.extra-option {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.8rem;
  padding-top: 0.8rem;
  border-top: 1px solid var(--line);
}
.extra-option .hint {
  padding-left: 1.45rem;
}
.advanced-pod {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}
.advanced-pod input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--accent);
}
.seed-input {
  width: 100%;
  padding: 0.55rem 0.6rem;
}
.errors {
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: rgb(248 113 113 / 0.04);
  padding: 0.65rem 0.8rem;
}
.errors h3 {
  margin-bottom: 0.3rem;
  font-size: 12px;
  color: var(--danger);
}
.errors ul {
  margin: 0;
  padding-left: 1.1rem;
  color: var(--text);
  font-size: 11px;
  white-space: pre-wrap;
}
.actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 0.1rem;
}
button.primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.7rem;
  min-width: 8.5rem;
  padding: 0.6rem 1rem;
  border-color: var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: var(--bg);
  font-weight: 600;
}
button.primary:hover:not(:disabled) {
  border-color: var(--accent);
  filter: brightness(1.08);
}
button.primary:disabled {
  border-color: var(--surface-2);
  background: var(--surface-2);
  color: var(--muted);
  opacity: 1;
}
.button-arrow {
  font-size: 15px;
  line-height: 1;
}
.optional {
  text-transform: none;
  letter-spacing: 0;
  font-size: 10px;
  font-weight: 500;
}

@media (max-width: 620px) {
  .choice-grid {
    grid-template-columns: 1fr;
  }
  .deck-row {
    grid-template-columns: 2rem minmax(0, 1fr);
  }
  .tag-field {
    grid-column: 2;
  }
}

@media (max-width: 430px) {
  .setup {
    padding-inline: 0.65rem;
  }
  .setup-header,
  .panel {
    padding-inline: 0.8rem;
  }
  .header-mark {
    display: none;
  }
  .seat-picker {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
