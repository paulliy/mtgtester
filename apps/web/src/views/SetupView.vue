<script setup lang="ts">
/**
 * The new-game screen (brief §10.2, §8): quick starts on top, a deck gallery, and a summary of
 * the four seats with the one Start button.
 *
 * There is one setup flow. Two quick starts cover the common cases with no choices at all; past
 * them, every option edits the same four seats. The gallery fills whichever seat is selected in
 * the summary, which is the human's by default, so choosing opponents' decks is the same gesture
 * as choosing your own rather than a separate "advanced" form.
 *
 * Generated decks stay the default. The engine halts on any unmodeled card, so a real decklist is
 * all-or-nothing (ADR 0009); generated and modeled decks are always playable, and an import is
 * pre-flighted by the matchup preview so a blocking card comes back here rather than as a
 * mid-game halt. The preview refreshes on every change instead of waiting for a button, and the
 * game seed is fixed on the client so a refresh never reshuffles the generated decks.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  Color,
  GameMode,
  ProviderKind,
  SavedDeckOption,
  SeatSource,
  SetupPreview,
} from '@mtg/shared';
import ManaPips from '../components/ManaPips.vue';
import { scryfallImageUrl } from '../lib/card';
import { useConfirmedStart } from '../composables/useConfirmedStart';
import { PROVIDER_LABELS, controllerLabel } from '../lib/providerLabels';
import { readRecentIds, syncRecentDeckIds } from '../lib/recentSetup';
import { useGameStore } from '../stores/game';

const store = useGameStore();
const { starting, startErrors, begin, clearStartErrors } = useConfirmedStart();

const SEATS = 4;
const SEAT_IDS = ['P1', 'P2', 'P3', 'P4'] as const;

/**
 * Decks that have already been imported and measured for engine model coverage (`bun run
 * coverage`). Each one's modeled fraction is shown up front rather than discovered as a
 * mid-setup halt (ADR 0009).
 */
interface KnownDeck {
  slug: string;
  name: string;
  commanderNames: string[];
  commanderScryfallIds: string[];
  colorIdentity: Color[];
  uniqueCards: number;
  modeledCards: number;
  /** Inferred archetype (ADR 0022 §5) — what the deck does, which the name rarely says. */
  archetypeTag: string;
  text: string;
}

/** What one seat will play. `pool` with no seed takes its generated deck from the game seed. */
type SeatChoice =
  | { kind: 'pool'; seed: string | null }
  | { kind: 'known'; slug: string }
  | { kind: 'saved'; snapshotId: string }
  | { kind: 'import'; text: string; tag: string };

/** Eight hex characters, the same shape as a server-made seed. Works outside secure contexts. */
function freshSeed(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

const gameMode = ref<GameMode>('singlePlayer');
const humanSeat = ref<string>('P1');
const providerKind = ref<ProviderKind>('random');
/**
 * Post-game AI commentary (ADR 0022 §7). Off by default and only offered with AI bots: it spends
 * budget after the game is already over, so it is an explicit per-game choice.
 */
const reflectionEnabled = ref(false);
/**
 * Table talk and deals between the bots (ADR 0035). Offered only when watching rule-based bots:
 * the deals run inside the heuristic bot, and a human seat cannot take part yet.
 */
const diplomacy = ref(false);
/** A replay seed the user typed. Blank means the session's own seed below. */
const customSeed = ref('');
const sessionSeed = ref(freshSeed());
const seed = computed(() => customSeed.value.trim() || sessionSeed.value);
const choices = ref<SeatChoice[]>(
  Array.from({ length: SEATS }, () => ({ kind: 'pool', seed: null })),
);
/** The seat the gallery fills. Follows the human seat until another seat is picked. */
const activeSeat = ref(0);

const knownDecks = ref<KnownDeck[]>([]);
const knownDecksError = ref<string | null>(null);
const knownDecksLoaded = ref(false);
const saved = ref<SavedDeckOption[]>([]);
const persistence = ref(false);
const recentDecks = ref<string[]>(readRecentIds('mtg-recent-deck-ids'));

const preview = ref<SetupPreview | null>(null);
/** The selections `preview` answers. Start is offered only while they still match. */
const previewKey = ref('');
const previewBusy = ref(false);
const previewError = ref('');
const quickError = ref('');
/** Which start is in flight or last failed, so its outcome shows beside the button pressed. */
const startedFrom = ref<'quick' | 'custom' | null>(null);
const quickBusy = ref(false);
const quickMode = ref<GameMode | null>(null);
/** Commander art that failed to load, by URL, so the tile falls back to its color band. */
const brokenArt = ref<string[]>([]);

onMounted(async () => {
  try {
    const response = await fetch('/api/saved-decks');
    if (!response.ok) throw new Error('Could not load saved decks.');
    const data = (await response.json()) as { enabled: boolean; decks: SavedDeckOption[] };
    persistence.value = data.enabled;
    saved.value = data.decks;
    // Only a database-backed server can say which saved decks still exist; without one the deck
    // recents are left exactly as stored.
    recentDecks.value = syncRecentDeckIds('mtg-recent-deck-ids', recentDecks.value, {
      enabled: data.enabled,
      available: data.decks.map((deck) => deck.snapshotId),
    });
  } catch {
    persistence.value = false;
  }
  try {
    const response = await fetch('/api/known-decks');
    if (!response.ok)
      throw new Error(
        ((await response.json()) as { message?: string }).message ?? 'Could not load known decks.',
      );
    knownDecks.value = ((await response.json()) as { decks: KnownDeck[] }).decks;
  } catch (reason) {
    knownDecksError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    knownDecksLoaded.value = true;
  }
});

const humanIndex = computed(() =>
  gameMode.value === 'singlePlayer' ? Number(humanSeat.value.slice(1)) - 1 : -1,
);

/**
 * The deck a seat's generated choice stands for. With no seed of its own it is drawn from the
 * game seed and the seat's index (`previewMatchup`), so moving it to another seat would change
 * it; this pins the seed it already has.
 */
function pinGenerated(choice: SeatChoice, index: number): SeatChoice {
  return choice.kind === 'pool' && choice.seed === null
    ? { kind: 'pool', seed: `${seed.value}-seat${index + 1}` }
    : choice;
}

/** Your deck follows you to a new seat, and so does the gallery. */
watch(humanSeat, (next, previous) => {
  const to = Number(next.slice(1)) - 1;
  const from = Number(previous.slice(1)) - 1;
  const list = choices.value.map((choice, index) =>
    index === to || index === from ? pinGenerated(choice, index) : choice,
  );
  [list[to], list[from]] = [list[from]!, list[to]!];
  choices.value = list;
  if (activeSeat.value === from) activeSeat.value = to;
});

const galleryDecks = computed(() => knownDecks.value.map((deck) => ({ deck, art: deckArt(deck) })));

const orderedSaved = computed(() =>
  [...saved.value].sort((a, b) => {
    const ai = recentDecks.value.indexOf(a.snapshotId);
    const bi = recentDecks.value.indexOf(b.snapshotId);
    return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
  }),
);

function seatName(index: number): string {
  return index === humanIndex.value ? 'you' : `P${index + 1}`;
}

function controllerFor(index: number): string {
  if (index === humanIndex.value) return 'You';
  return PROVIDER_LABELS[providerKind.value].replace(/s$/, '');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A slug such as `token-triumph` as words, for a deck whose file name is its only title. */
function deckTitle(deck: KnownDeck): string {
  return capitalize(deck.name.replace(/[-_]+/g, ' ').trim());
}

function markBroken(url: string): void {
  if (!brokenArt.value.includes(url)) brokenArt.value = [...brokenArt.value, url];
}

/** The illustration of a deck's first commander, or null when it has none to show. */
function deckArt(deck: KnownDeck): string | null {
  const id = deck.commanderScryfallIds?.[0];
  if (id === undefined || id.length < 2) return null;
  const url = scryfallImageUrl(id, 'art_crop');
  return brokenArt.value.includes(url) ? null : url;
}

/** The deck's title under its commander, unless it only repeats the commander's name. */
function deckSubtitle(deck: KnownDeck): string {
  const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const title = deckTitle(deck);
  return deck.commanderNames.some((name) => plain(name) === plain(title)) ? '' : title;
}

/** A saved deck's name, unless the server only had its commanders to name it by. */
function savedSubtitle(deck: SavedDeckOption): string {
  return deck.name === deck.commanderNames.join(' & ') ? 'Saved deck' : `Saved · ${deck.name}`;
}

function choiceLabel(choice: SeatChoice): string {
  switch (choice.kind) {
    case 'pool':
      return 'Generated deck';
    case 'known': {
      const deck = knownDecks.value.find((d) => d.slug === choice.slug);
      return deck ? deck.commanderNames.join(' & ') : 'Modeled deck';
    }
    case 'saved': {
      const deck = saved.value.find((d) => d.snapshotId === choice.snapshotId);
      return deck ? deck.name : 'Saved deck';
    }
    case 'import':
      return 'Imported deck';
  }
}

function isComplete(choice: SeatChoice): boolean {
  switch (choice.kind) {
    case 'pool':
      return true;
    case 'known':
      return knownDecks.value.some((d) => d.slug === choice.slug);
    case 'saved':
      return choice.snapshotId !== '';
    case 'import':
      return choice.text.trim() !== '';
  }
}

function sourceFor(choice: SeatChoice): SeatSource {
  switch (choice.kind) {
    case 'pool':
      return choice.seed === null ? { kind: 'pool' } : { kind: 'pool', seed: choice.seed };
    case 'known': {
      const deck = knownDecks.value.find((d) => d.slug === choice.slug);
      return { kind: 'plaintext', text: deck?.text ?? '' };
    }
    case 'saved':
      return { kind: 'snapshot', snapshotId: choice.snapshotId };
    case 'import': {
      const raw = choice.text.trim();
      const tag = choice.tag.trim();
      if (/^https?:\/\//i.test(raw))
        return { kind: 'url', url: raw, ...(tag !== '' && { archetypeTag: tag }) };
      return { kind: 'plaintext', text: raw, ...(tag !== '' && { archetypeTag: tag }) };
    }
  }
}

const ready = computed(() => choices.value.every(isComplete));

/** Exactly what the server compares between a preview and the start that redeems it. */
const request = computed(() => ({
  seats: choices.value.map(sourceFor),
  providerKind: providerKind.value,
  seed: seed.value,
  gameMode: gameMode.value,
  ...(gameMode.value === 'singlePlayer' && { humanSeat: humanSeat.value }),
}));
const requestKey = computed(() => JSON.stringify(request.value));

const current = computed(() =>
  preview.value !== null && previewKey.value === requestKey.value ? preview.value : null,
);
// One start at a time: a quick start holds this button for its whole preview-then-start.
const canStart = computed(
  () =>
    current.value !== null &&
    current.value.blockers.length === 0 &&
    !starting.value &&
    !quickBusy.value,
);

async function fetchPreview(body: object): Promise<SetupPreview> {
  const response = await fetch('/api/setup-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as SetupPreview & { message?: string };
  if (!response.ok) throw new Error(result.message ?? 'Preview failed.');
  return result;
}

let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewGeneration = 0;

async function refreshPreview(): Promise<void> {
  const generation = ++previewGeneration;
  if (!ready.value) {
    previewBusy.value = false;
    return;
  }
  const key = requestKey.value;
  previewBusy.value = true;
  previewError.value = '';
  try {
    const result = await fetchPreview(request.value);
    if (generation !== previewGeneration) return;
    preview.value = result;
    previewKey.value = key;
  } catch (reason) {
    if (generation !== previewGeneration) return;
    previewError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (generation === previewGeneration) previewBusy.value = false;
  }
}

/** Typing an import waits longer, so a pasted list is not fetched once per keystroke. */
function schedulePreview(): void {
  clearTimeout(previewTimer);
  const typing = choices.value.some((c) => c.kind === 'import') || customSeed.value !== '';
  previewTimer = setTimeout(() => void refreshPreview(), typing ? 700 : 150);
}

watch(
  requestKey,
  () => {
    clearStartErrors();
    quickError.value = '';
    schedulePreview();
  },
  { immediate: true },
);
// A start redeems its preview, so a refused start needs a fresh one before the next try.
watch(startErrors, (errors) => {
  if (errors.length > 0) schedulePreview();
});
onBeforeUnmount(() => clearTimeout(previewTimer));

function setChoice(index: number, choice: SeatChoice): void {
  const list = [...choices.value];
  list[index] = choice;
  choices.value = list;
}

function pickKnown(slug: string): void {
  setChoice(activeSeat.value, { kind: 'known', slug });
}
function pickSaved(snapshotId: string): void {
  setChoice(activeSeat.value, { kind: 'saved', snapshotId });
}
function pickGenerated(): void {
  const choice = choices.value[activeSeat.value];
  if (choice?.kind !== 'pool') setChoice(activeSeat.value, { kind: 'pool', seed: null });
}
function pickImport(): void {
  const choice = choices.value[activeSeat.value];
  if (choice?.kind !== 'import') setChoice(activeSeat.value, { kind: 'import', text: '', tag: '' });
}
function reroll(index: number): void {
  setChoice(index, { kind: 'pool', seed: freshSeed() });
}

const activeChoice = computed(() => choices.value[activeSeat.value]!);

function start(): void {
  const matchup = current.value;
  if (!matchup || matchup.blockers.length > 0 || quickBusy.value) return;
  // The start redeems this preview, so it must not be offered again. A refused start brings a
  // fresh one through the `startErrors` watch.
  preview.value = null;
  startedFrom.value = 'custom';
  begin(() =>
    store.startGame(
      request.value.seats,
      providerKind.value,
      matchup.seed,
      gameMode.value,
      humanSeat.value,
      providerKind.value === 'ai' && reflectionEnabled.value,
      matchup.previewId,
      undefined,
      {
        diplomacy:
          gameMode.value === 'spectator' && providerKind.value === 'random' && diplomacy.value,
      },
    ),
  );
}

/** One click: four generated decks, built-in bots, a fresh seed. */
async function quickStart(mode: GameMode): Promise<void> {
  if (quickBusy.value || starting.value) return;
  quickBusy.value = true;
  quickMode.value = mode;
  quickError.value = '';
  startedFrom.value = 'quick';
  const seats: SeatSource[] = Array.from({ length: SEATS }, () => ({ kind: 'pool' }));
  const body = {
    seats,
    providerKind: 'random' as const,
    seed: freshSeed(),
    gameMode: mode,
    ...(mode === 'singlePlayer' && { humanSeat: 'P1' }),
  };
  try {
    const result = await fetchPreview(body);
    if (result.blockers.length > 0) throw new Error(result.blockers.join('\n'));
    // Another start may have gone out while this preview was in flight.
    if (starting.value) return;
    begin(() => store.startGame(seats, 'random', result.seed, mode, 'P1', false, result.previewId));
  } catch (reason) {
    quickError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    quickBusy.value = false;
  }
}

/**
 * The summary's line for one seat: the preview's answer when it has one, else the choice. A
 * blocked seat shows only the choice, never the preview's names: those came from a list nothing
 * has validated, and three of the four seats are opponents.
 */
const seatRows = computed(() =>
  choices.value.map((choice, index) => {
    const seat = current.value?.seats[index];
    const shown = seat?.modeled === true ? seat : undefined;
    return {
      index,
      id: SEAT_IDS[index]!,
      controller: seat ? capitalize(controllerLabel(seat.controller)) : controllerFor(index),
      title: shown?.commanderNames.join(' & ') || choiceLabel(choice),
      colors: shown?.colorIdentity ?? null,
      archetype: shown?.archetypeTag ?? '',
      status: !isComplete(choice)
        ? 'Choose a deck'
        : !ready.value
          ? ''
          : !seat
            ? previewError.value !== ''
              ? ''
              : 'Checking…'
            : seat.modeled
              ? 'Fully modeled'
              : 'Blocked. See the reason below.',
      pool: choice.kind === 'pool',
    };
  }),
);
</script>

<template>
  <div class="setup">
    <h1>New game</h1>

    <section class="quick" aria-label="Quick start">
      <div class="quick-card quick-play">
        <span class="kicker">Quick game</span>
        <strong>Play a random deck against three bots</strong>
        <span class="quick-copy">Built-in bots, a fresh seed, no setup.</span>
        <button type="button" :disabled="starting || quickBusy" @click="quickStart('singlePlayer')">
          {{ quickMode === 'singlePlayer' && (quickBusy || starting) ? 'Starting…' : 'Play now' }}
        </button>
      </div>
      <div class="quick-card">
        <span class="kicker">Spectate</span>
        <strong>Watch four bots play it out</strong>
        <span class="quick-copy">Scrub turns and see every hand.</span>
        <button type="button" :disabled="starting || quickBusy" @click="quickStart('spectator')">
          {{ quickMode === 'spectator' && (quickBusy || starting) ? 'Starting…' : 'Watch now' }}
        </button>
      </div>
    </section>
    <p v-if="quickError" class="error-box" role="alert">{{ quickError }}</p>
    <div v-if="startedFrom === 'quick' && startErrors.length > 0" class="error-box" role="alert">
      <strong>The game did not start</strong>
      <ul>
        <li v-for="(error, index) in startErrors" :key="index">{{ error }}</li>
      </ul>
    </div>

    <div class="layout">
      <section class="gallery-area" aria-labelledby="gallery-title">
        <div class="gallery-head">
          <h2 id="gallery-title">Or pick a deck for {{ seatName(activeSeat) }}</h2>
          <span class="muted">Every modeled deck plays without engine halts.</span>
        </div>
        <p v-if="!persistence" class="hint">
          Saved and imported decks are disabled without a database. Generated decks remain
          available.
        </p>
        <p v-if="knownDecksError !== null" class="error-box">
          Modeled decks unavailable: {{ knownDecksError }}
        </p>

        <div v-if="activeChoice.kind === 'import'" class="import-panel">
          <label class="field">
            <span>Deck URL or decklist for {{ seatName(activeSeat) }}</span>
            <textarea
              v-model="activeChoice.text"
              rows="5"
              placeholder="https://moxfield.com/decks/… or a pasted decklist"
            ></textarea>
          </label>
          <!-- Leaving this blank is the normal path: the server classifies the resolved list
               (ADR 0022 §5). Anything typed here wins outright and is never overwritten. -->
          <label class="field tag-field">
            <span>Archetype tag (optional)</span>
            <input v-model="activeChoice.tag" type="text" placeholder="Detected if blank" />
          </label>
        </div>

        <div class="gallery">
          <button
            type="button"
            class="tile tile-generated"
            :class="{ selected: activeChoice.kind === 'pool' }"
            :aria-pressed="activeChoice.kind === 'pool'"
            @click="pickGenerated"
          >
            <span class="art art-generated" aria-hidden="true"></span>
            <span class="tile-body">
              <strong>Generated deck</strong>
              <span class="tile-sub">Built from cards the engine fully supports.</span>
            </span>
          </button>
          <button
            v-for="{ deck, art } in galleryDecks"
            :key="deck.slug"
            type="button"
            class="tile"
            :class="{ selected: activeChoice.kind === 'known' && activeChoice.slug === deck.slug }"
            :aria-pressed="activeChoice.kind === 'known' && activeChoice.slug === deck.slug"
            :disabled="!persistence"
            :title="deckTitle(deck)"
            @click="pickKnown(deck.slug)"
          >
            <span v-if="art" class="art" aria-hidden="true">
              <img :src="art" alt="" loading="lazy" @error="markBroken(art)" />
            </span>
            <span class="band" aria-hidden="true">
              <span
                v-for="c in deck.colorIdentity.length ? deck.colorIdentity : ['C']"
                :key="c"
                :class="`band-${c}`"
              ></span>
            </span>
            <span class="tile-body">
              <strong>{{ deck.commanderNames.join(' & ') }}</strong>
              <span v-if="deckSubtitle(deck)" class="tile-sub">{{ deckSubtitle(deck) }}</span>
              <span class="tile-meta">
                <ManaPips :colors="deck.colorIdentity" />
                <span class="archetype">{{ deck.archetypeTag }}</span>
              </span>
            </span>
          </button>
          <button
            v-for="deck in orderedSaved"
            :key="deck.snapshotId"
            type="button"
            class="tile"
            :class="{
              selected:
                activeChoice.kind === 'saved' && activeChoice.snapshotId === deck.snapshotId,
            }"
            :aria-pressed="
              activeChoice.kind === 'saved' && activeChoice.snapshotId === deck.snapshotId
            "
            @click="pickSaved(deck.snapshotId)"
          >
            <span class="band band-saved" aria-hidden="true"></span>
            <span class="tile-body">
              <strong>{{ deck.commanderNames.join(' & ') }}</strong>
              <span class="tile-sub">{{ savedSubtitle(deck) }}</span>
              <span class="tile-meta">
                <ManaPips :colors="deck.colorIdentity" />
                <span class="archetype">{{ deck.archetypeTag }}</span>
              </span>
            </span>
          </button>
          <button
            type="button"
            class="tile tile-dashed"
            :class="{ selected: activeChoice.kind === 'import' }"
            :aria-pressed="activeChoice.kind === 'import'"
            :disabled="!persistence"
            @click="pickImport"
          >
            <span class="tile-body centered">
              <strong>Import a deck</strong>
              <span class="tile-sub">Moxfield, Archidekt or a pasted list</span>
            </span>
          </button>
        </div>
        <p v-if="!knownDecksLoaded" class="hint">Loading modeled decks…</p>
      </section>

      <aside class="summary" aria-labelledby="summary-title">
        <div class="summary-head">
          <h2 id="summary-title">Your game</h2>
          <div class="segmented" role="radiogroup" aria-label="Game mode">
            <label :class="{ on: gameMode === 'singlePlayer' }">
              <input v-model="gameMode" type="radio" value="singlePlayer" />Play
            </label>
            <label :class="{ on: gameMode === 'spectator' }">
              <input v-model="gameMode" type="radio" value="spectator" />Watch
            </label>
          </div>
        </div>

        <ul class="seats" aria-label="Matchup preview" :aria-busy="previewBusy">
          <li
            v-for="row in seatRows"
            :key="row.id"
            class="seat"
            :class="{ active: activeSeat === row.index, human: row.index === humanIndex }"
          >
            <button
              type="button"
              class="seat-main"
              :aria-pressed="activeSeat === row.index"
              @click="activeSeat = row.index"
            >
              <span class="seat-label">{{ row.id }} · {{ row.controller }}</span>
              <strong class="seat-title">{{ row.title }}</strong>
              <span class="seat-meta">
                <ManaPips v-if="row.colors" :colors="row.colors" />
                <span v-if="row.archetype" class="archetype">{{ row.archetype }}</span>
              </span>
              <span
                class="status"
                :class="{
                  ok: row.status === 'Fully modeled',
                  bad: row.status.startsWith('Blocked'),
                }"
                >{{ row.status }}</span
              >
            </button>
            <button
              v-if="row.pool"
              type="button"
              class="reroll"
              :aria-label="`Reroll the generated deck for ${row.id}`"
              @click="reroll(row.index)"
            >
              Reroll
            </button>
          </li>
        </ul>
        <p class="muted small">
          Select a seat to choose its deck from the gallery. Seed: {{ current?.seed ?? seed }}
        </p>

        <div class="segmented wide" role="radiogroup" aria-label="Bots">
          <label :class="{ on: providerKind === 'random' }">
            <input v-model="providerKind" type="radio" value="random" />{{ PROVIDER_LABELS.random }}
          </label>
          <label :class="{ on: providerKind === 'ai' }">
            <input v-model="providerKind" type="radio" value="ai" />{{ PROVIDER_LABELS.ai }}
          </label>
        </div>
        <p class="hint">
          {{
            providerKind === 'ai'
              ? 'Strategic bot decisions. May spend API budget.'
              : 'Rule-based bots: fast, free, and fully seeded.'
          }}
        </p>
        <label v-if="providerKind === 'ai'" class="check">
          <input v-model="reflectionEnabled" type="checkbox" />
          <span
            >Post-game commentary
            <span class="hint"
              >Each bot reviews its own play once the game ends. One extra call per bot.</span
            ></span
          >
        </label>

        <label v-if="gameMode === 'spectator' && providerKind === 'random'" class="check">
          <input v-model="diplomacy" type="checkbox" />
          <span
            >Table talk and deals
            <span class="hint"
              >Bots call out threats and make short deals, shown in the log and on each seat.</span
            ></span
          >
        </label>

        <details class="more">
          <summary>More options</summary>
          <div v-if="gameMode === 'singlePlayer'" class="field">
            <span>Your seat</span>
            <div class="seat-options" role="radiogroup" aria-label="Your seat">
              <button
                v-for="id in SEAT_IDS"
                :key="id"
                type="button"
                class="seat-pill"
                :class="{ on: humanSeat === id }"
                role="radio"
                :aria-checked="humanSeat === id"
                @click="humanSeat = id"
              >
                {{ id }}
              </button>
            </div>
          </div>
          <label class="field">
            <span>Replay seed</span>
            <input v-model="customSeed" type="text" placeholder="Fresh seed" />
          </label>
          <p class="hint">Repeat a known shuffle with its seed. AI decisions may still vary.</p>
        </details>

        <div v-if="previewError" class="error-box" role="alert">
          <p>{{ previewError }}</p>
          <button type="button" class="retry" :disabled="previewBusy" @click="refreshPreview">
            Try again
          </button>
        </div>
        <div v-if="current && current.blockers.length" class="error-box" role="alert">
          <strong>This matchup can't start</strong>
          <ul>
            <li v-for="blocker in current.blockers" :key="blocker">{{ blocker }}</li>
          </ul>
        </div>
        <div
          v-if="startedFrom === 'custom' && startErrors.length > 0"
          class="error-box"
          role="alert"
        >
          <strong>The game did not start</strong>
          <ul>
            <li v-for="(error, index) in startErrors" :key="index">{{ error }}</li>
          </ul>
        </div>

        <button type="button" class="primary" :disabled="!canStart" @click="start">
          {{ starting && startedFrom === 'custom' ? 'Starting…' : 'Start game' }}
        </button>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.setup {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  font-size: 14px;
}
h1,
h2,
p {
  margin: 0;
}
h1 {
  font-size: 1.6rem;
  letter-spacing: -0.02em;
}
h2 {
  font-size: 1.05rem;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 12px;
}
.hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}
.error-box {
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: rgb(248 113 113 / 0.06);
  padding: 0.6rem 0.8rem;
  color: var(--text);
  font-size: 13px;
  white-space: pre-wrap;
}
.error-box strong {
  color: var(--danger);
}
.error-box .retry {
  margin-top: 0.4rem;
  min-height: 34px;
  padding: 0 0.8rem;
  border-radius: 6px;
  font-weight: 600;
}
.error-box ul {
  margin: 0.3rem 0 0;
  padding-left: 1.1rem;
}

/* Quick starts */
.quick {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.9rem;
}
.quick-card {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 1.1rem 1.2rem;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
}
.quick-card strong {
  font-size: 1.15rem;
  line-height: 1.25;
}
.quick-card button {
  align-self: flex-start;
  min-height: 44px;
  margin-top: 0.3rem;
  padding: 0 1.25rem;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: transparent;
  color: var(--accent);
  font-weight: 700;
}
.quick-play {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.quick-play button {
  background: var(--accent);
  color: var(--bg);
}
.kicker {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.quick-copy {
  color: var(--muted);
}

/* Gallery + summary */
.layout {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 1.25rem;
}
.gallery-area {
  flex: 999 1 560px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.gallery-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}
.gallery-head .muted {
  font-size: 13px;
}
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 0.7rem;
}
.tile {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  text-align: left;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  min-height: 132px;
}
.tile:hover:not(:disabled) {
  border-color: var(--accent);
}
.tile.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}
.tile:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.tile-dashed {
  border-style: dashed;
  background: transparent;
}
.art {
  display: block;
  height: 84px;
  overflow: hidden;
  background: var(--surface-2);
}
.art img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 30%;
}
.band {
  display: flex;
  height: 10px;
  flex-shrink: 0;
}
.band > span {
  flex: 1 1 0;
}
.band-W {
  background: #e9dfb8;
}
.band-U {
  background: #3b82c4;
}
.band-B {
  background: #4b4b52;
}
.band-R {
  background: #c2412d;
}
.band-G {
  background: #2f8a4b;
}
.band-C {
  background: #9ca3af;
}
.art-generated {
  background: repeating-linear-gradient(135deg, var(--line) 0 6px, transparent 6px 12px);
}
.band-saved {
  background: var(--accent);
}
.tile-body {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.7rem 0.8rem 0.8rem;
  flex: 1 1 auto;
}
.tile-body.centered {
  align-items: center;
  justify-content: center;
  text-align: center;
}
.tile-body strong {
  font-size: 14px;
  line-height: 1.25;
}
.tile-sub {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tile-meta,
.seat-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  margin-top: auto;
}
.archetype {
  color: var(--muted);
  font-size: 12px;
}
.archetype::first-letter {
  text-transform: uppercase;
}
.import-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 13rem;
  gap: 0.75rem;
  padding: 0.9rem;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.field textarea,
.field input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-weight: 400;
  font-size: 13px;
}
.field textarea {
  resize: vertical;
}

/* Summary */
.summary {
  flex: 1 1 320px;
  max-width: 100%;
  position: sticky;
  top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
}
.summary-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}
.segmented {
  display: inline-flex;
  padding: 3px;
  gap: 3px;
  border-radius: 8px;
  background: var(--surface-2);
}
.segmented.wide {
  display: flex;
}
.segmented label {
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 0.8rem;
  border-radius: 6px;
  color: var(--muted);
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.segmented label.on {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
}
.segmented label:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.segmented input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}
.seats {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.seat {
  position: relative;
  display: flex;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.seat.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.seat-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.2rem;
  padding: 0.55rem 0.7rem;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.seat-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.seat.human .seat-label {
  color: var(--accent);
}
.seat-title {
  font-size: 14px;
}
.status {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
}
.status.ok {
  color: var(--ok);
}
.status.bad {
  color: var(--danger);
}
.reroll {
  align-self: center;
  margin-right: 0.5rem;
  min-height: 34px;
  padding: 0 0.6rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}
.check {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  cursor: pointer;
}
.check input {
  margin-top: 0.2rem;
  accent-color: var(--accent);
}
.check .hint {
  display: block;
}
.more {
  border-top: 1px solid var(--line);
  padding-top: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.more > summary {
  cursor: pointer;
  color: var(--accent);
  font-weight: 500;
}
.more[open] {
  display: flex;
}
.more[open] > summary {
  margin-bottom: 0.2rem;
}
.seat-options {
  display: flex;
  gap: 0.35rem;
}
.seat-pill {
  min-width: 2.75rem;
  min-height: 34px;
  border-radius: 999px;
  color: var(--muted);
  font-weight: 700;
}
.seat-pill.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}
button.primary {
  min-height: 48px;
  border: 1px solid var(--accent);
  border-radius: 9px;
  background: var(--accent);
  color: var(--bg);
  font-size: 15px;
  font-weight: 700;
}
button.primary:disabled {
  border-color: var(--surface-2);
  background: var(--surface-2);
  color: var(--muted);
  opacity: 1;
}

@media (max-width: 620px) {
  .quick {
    grid-template-columns: 1fr;
  }
  .import-panel {
    grid-template-columns: 1fr;
  }
  .summary {
    position: static;
  }
}
</style>
