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
  StartGameMode,
  ProviderKind,
  SavedDeckOption,
  SeatSource,
  SetupPreview,
} from '@mtg/shared';
import ManaPips from '../components/ManaPips.vue';
import ModeCompass from '../components/setup/ModeCompass.vue';
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

const gameMode = ref<StartGameMode>('singlePlayer');
const humanSeat = ref<string>('P1');
const providerKind = ref<ProviderKind>('random');
/**
 * Post-game AI commentary (ADR 0022 §7). Off by default and only offered with AI bots: it spends
 * budget after the game is already over, so it is an explicit per-game choice.
 */
const reflectionEnabled = ref(false);
/**
 * Table talk and deals (ADR 0035), for any table, watching or playing. Rule-based bots negotiate
 * on their own; model-driven seats propose through their strategist, with no extra calls.
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
const quickMode = ref<StartGameMode | null>(null);
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
        diplomacy: diplomacy.value,
      },
    ),
  );
}

/** One click: four generated decks, built-in bots, a fresh seed. */
async function quickStart(mode: StartGameMode): Promise<void> {
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
/** The display title under the compass (the page's `<h1>` stays "New game"). */
const modeTitle = computed(() =>
  gameMode.value === 'singlePlayer' ? 'Play against bots' : 'Watch the bots',
);
const modeLine = computed(() =>
  gameMode.value === 'singlePlayer'
    ? 'You take a seat; three bots take the others.'
    : 'Four bots play it out. Scrub turns and see every hand.',
);

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
    <section class="stage" aria-labelledby="new-game-title">
      <div class="title-g dt-rise">
        <h1 id="new-game-title" class="dt-kicker page-h1">New game</h1>
        <p class="mode-title">{{ modeTitle }}</p>
        <p class="mode-line">{{ modeLine }}</p>
      </div>

      <ModeCompass v-model="gameMode" :disabled="starting || quickBusy" />

      <section class="quick" aria-label="Quick start">
        <div class="quick-card quick-play">
          <span class="dt-kicker">Quick game</span>
          <strong>Play a random deck against three bots</strong>
          <span class="quick-copy">Built-in bots, a fresh seed, no setup.</span>
          <button
            type="button"
            class="dt-btn-primary"
            :disabled="starting || quickBusy"
            @click="quickStart('singlePlayer')"
          >
            {{ quickMode === 'singlePlayer' && (quickBusy || starting) ? 'Starting…' : 'Play now' }}
          </button>
        </div>
        <div class="quick-card">
          <span class="dt-kicker">Spectate</span>
          <strong>Watch four bots play it out</strong>
          <span class="quick-copy">Scrub turns and see every hand.</span>
          <button
            type="button"
            class="dt-btn"
            :disabled="starting || quickBusy"
            @click="quickStart('spectator')"
          >
            {{ quickMode === 'spectator' && (quickBusy || starting) ? 'Starting…' : 'Watch now' }}
          </button>
        </div>
      </section>
      <p v-if="quickError" class="dt-note danger" role="alert">{{ quickError }}</p>
      <div
        v-if="startedFrom === 'quick' && startErrors.length > 0"
        class="dt-note danger"
        role="alert"
      >
        <strong>The game did not start</strong>
        <ul>
          <li v-for="(error, index) in startErrors" :key="index">{{ error }}</li>
        </ul>
      </div>

      <section class="gallery-area" aria-labelledby="gallery-title">
        <div class="gallery-head">
          <h2 id="gallery-title" class="dt-head">
            <span class="num" aria-hidden="true">{{
              seatName(activeSeat) === 'you' ? '★' : '◆'
            }}</span>
            Or pick a deck for {{ seatName(activeSeat) }}
          </h2>
          <span class="muted">Every modeled deck plays without engine halts.</span>
        </div>
        <div class="seat-switch dt-seg" role="group" aria-label="Seat to choose for">
          <button
            v-for="(id, index) in SEAT_IDS"
            :key="id"
            type="button"
            :aria-pressed="activeSeat === index"
            :aria-label="`Choose the deck for ${seatName(index)}`"
            @click="activeSeat = index"
          >
            {{ id }}
          </button>
        </div>
        <p v-if="!persistence" class="hint">
          Saved and imported decks are disabled without a database. Generated decks remain
          available.
        </p>
        <p v-if="knownDecksError !== null" class="dt-note danger">
          Modeled decks unavailable: {{ knownDecksError }}
        </p>

        <div v-if="activeChoice.kind === 'import'" class="import-panel dt-plate">
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
    </section>

    <aside class="summary" aria-labelledby="summary-title">
      <div class="summary-head">
        <span class="dt-kicker">Set up</span>
        <h2 id="summary-title">Your game</h2>
        <div class="dt-seg mode-seg" role="radiogroup" aria-label="Game mode">
          <label :class="{ on: gameMode === 'singlePlayer' }">
            <input v-model="gameMode" type="radio" value="singlePlayer" />Play
          </label>
          <label :class="{ on: gameMode === 'spectator' }">
            <input v-model="gameMode" type="radio" value="spectator" />Watch
          </label>
        </div>
      </div>

      <div class="summary-scroll">
        <h3 class="dt-head"><span class="num">I.</span> Seats</h3>
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
              <span class="seat-id" aria-hidden="true">{{ row.id }}</span>
              <span class="seat-text">
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
              </span>
            </button>
            <button
              v-if="row.pool"
              type="button"
              class="reroll dt-btn small"
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

        <h3 class="dt-head"><span class="num">II.</span> Bots</h3>
        <div class="dt-seg" role="radiogroup" aria-label="Bots">
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

        <h3 class="dt-head"><span class="num">III.</span> Extras</h3>
        <label class="check">
          <input v-model="diplomacy" type="checkbox" />
          <span
            >Table talk and deals
            <span class="hint"
              >Bots call out threats and make short deals{{
                gameMode === 'singlePlayer' ? ' with you' : ''
              }}.</span
            ></span
          >
        </label>

        <details class="more">
          <summary>More options</summary>
          <div v-if="gameMode === 'singlePlayer'" class="field">
            <span>Your seat</span>
            <div class="seat-options dt-seg" role="radiogroup" aria-label="Your seat">
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

        <div v-if="previewError" class="dt-note danger" role="alert">
          <p>{{ previewError }}</p>
          <button
            type="button"
            class="retry dt-btn small"
            :disabled="previewBusy"
            @click="refreshPreview"
          >
            Try again
          </button>
        </div>
        <div v-if="current && current.blockers.length" class="dt-note danger" role="alert">
          <strong>This matchup can't start</strong>
          <ul>
            <li v-for="blocker in current.blockers" :key="blocker">{{ blocker }}</li>
          </ul>
        </div>
        <div
          v-if="startedFrom === 'custom' && startErrors.length > 0"
          class="dt-note danger"
          role="alert"
        >
          <strong>The game did not start</strong>
          <ul>
            <li v-for="(error, index) in startErrors" :key="index">{{ error }}</li>
          </ul>
        </div>
      </div>

      <div class="summary-foot">
        <button type="button" class="dt-btn-primary wide" :disabled="!canStart" @click="start">
          {{ starting && startedFrom === 'custom' ? 'Starting…' : 'Start game'
          }}<span class="dt-arr" aria-hidden="true" />
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.setup {
  min-height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(20rem, 28rem);
  font-size: 14px;
}
p {
  margin: 0;
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
.dt-note {
  white-space: pre-wrap;
}
.dt-note .retry {
  margin-top: 0.5rem;
}

/* The stage: title, compass, quick starts and the deck gallery. */
.stage {
  min-width: 0;
  padding: 1.75rem 2.5rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}
.title-g {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.45rem;
  text-align: center;
}
.page-h1 {
  margin: 0;
  font-weight: 400;
}
.mode-title {
  font-family: var(--font-display);
  font-size: clamp(2.2rem, 4vw, 3.8rem);
  line-height: 0.95;
  letter-spacing: -0.03em;
  text-transform: uppercase;
}
.mode-line {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--muted);
}

.quick {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 1px solid var(--ink);
}
.quick-card {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 1.1rem 1.25rem 1.25rem;
}
.quick-card + .quick-card {
  border-left: 1px solid var(--ink);
}
.quick-play {
  background: var(--paper-2);
}
.quick-card strong {
  font-family: var(--font-body);
  font-weight: 400;
  font-size: 1.05rem;
  line-height: 1.3;
}
.quick-copy {
  color: var(--muted);
  font-size: 0.8rem;
}
.quick-card button {
  align-self: flex-start;
  margin-top: 0.4rem;
}

/* Gallery */
.gallery-area {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.gallery-head {
  display: grid;
  gap: 0.35rem;
}
.gallery-head .muted {
  font-family: var(--font-body);
  font-size: 0.8rem;
}
.seat-switch {
  max-width: 18rem;
}
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 0.75rem;
}
.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 132px;
  padding: 0;
  overflow: hidden;
  text-align: left;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  cursor: pointer;
  transition:
    background-color 0.3s var(--ease),
    box-shadow 0.3s var(--ease);
}
.tile:hover:not(:disabled) {
  background: var(--paper-2);
}
.tile.selected {
  box-shadow:
    inset 0 0 0 2px var(--paper),
    inset 0 0 0 3px var(--ink);
  background: var(--paper-2);
}
.tile.selected::after {
  content: 'Chosen';
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  padding: 0.1rem 0.4rem;
  background: var(--ink);
  color: var(--paper);
  font-family: var(--font-ui);
  font-size: 0.55rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.tile:disabled {
  opacity: 0.45;
  cursor: default;
}
.tile-dashed {
  border-style: dashed;
  justify-content: center;
}
.art {
  display: block;
  height: 78px;
  overflow: hidden;
  border-bottom: 1px solid var(--ink);
  background: var(--paper-2);
}
.art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  filter: saturate(0.75) sepia(0.12);
}
.band {
  display: flex;
  height: 4px;
}
.band > span {
  flex: 1;
}
.band-W {
  background: var(--mana-w);
}
.band-U {
  background: var(--mana-u);
}
.band-B {
  background: var(--mana-b);
}
.band-R {
  background: var(--mana-r);
}
.band-G {
  background: var(--mana-g);
}
.band-C {
  background: var(--mana-c);
}
.art-generated {
  background: repeating-linear-gradient(45deg, var(--paper-2) 0 8px, var(--paper) 8px 16px);
}
.band-saved {
  background: var(--warm);
}
.tile-body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.6rem 0.75rem 0.75rem;
}
.tile-body.centered {
  align-items: center;
  text-align: center;
}
.tile-body strong {
  font-family: var(--font-ui);
  font-weight: 500;
  font-size: 0.82rem;
  line-height: 1.25;
}
.tile-sub {
  font-family: var(--font-body);
  font-size: 0.72rem;
  line-height: 1.35;
  color: var(--muted);
}
.tile-meta,
.seat-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
.archetype {
  font-family: var(--font-ui);
  font-size: 0.6rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.import-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 14rem;
  gap: 1rem;
  padding: 1rem;
}
.field {
  display: grid;
  gap: 0.35rem;
  align-content: start;
}
.field > span {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.field textarea {
  min-height: 7rem;
  border: 1px solid var(--ink);
  font-family: var(--font-body);
  font-size: 0.85rem;
  resize: vertical;
}
.field input {
  min-height: 40px;
  border: 0;
  border-bottom: 1px solid var(--ink);
  background: transparent;
  font-family: var(--font-body);
}

/* The setup panel */
.summary {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--ink);
  background: var(--paper);
  position: sticky;
  top: 0;
  max-height: 100%;
  align-self: start;
  height: 100%;
  animation: dtFade 0.6s var(--ease) 0.25s both;
}
.summary-head {
  display: grid;
  gap: 0.5rem;
  padding: 1.25rem 1.5rem 1rem;
  border-bottom: 1px solid var(--ink);
}
.summary-head h2 {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 2rem;
  line-height: 1;
  letter-spacing: -0.03em;
  text-transform: uppercase;
}
.summary-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 1.1rem 1.5rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.summary-scroll .dt-head {
  margin-top: 0.6rem;
}
.summary-scroll .dt-head:first-child {
  margin-top: 0;
}
.summary-foot {
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--ink);
  background: var(--paper-2);
}
.seats {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
.seat {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--rule);
}
.seat-main {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 2.4rem minmax(0, 1fr);
  gap: 0.6rem;
  align-items: start;
  padding: 0.6rem 0.4rem;
  border: 0;
  text-align: left;
  transition: background-color 0.3s var(--ease);
}
.seat.active .seat-main {
  background: var(--paper-2);
  box-shadow: inset 3px 0 0 var(--ink);
}
.seat-id {
  font-family: var(--font-display);
  font-size: 1.5rem;
  line-height: 1;
}
.seat-text {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}
.seat-label {
  font-family: var(--font-ui);
  font-size: 0.6rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.seat.human .seat-label {
  color: var(--ink);
}
.seat-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-body);
  font-weight: 400;
  font-size: 0.95rem;
}
.status {
  font-family: var(--font-body);
  font-size: 0.72rem;
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
  margin-left: 0.4rem;
}
.check {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.6rem;
  align-items: start;
  cursor: pointer;
}
.check input {
  margin-top: 0.15rem;
  accent-color: var(--ink);
  width: 1.05rem;
  height: 1.05rem;
}
.check .hint {
  display: block;
}
.more {
  border: 1px solid var(--rule);
}
.more > summary {
  padding: 0.6rem 0.8rem;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: 0.68rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.more[open] {
  display: grid;
  gap: 0.75rem;
  padding-bottom: 0.8rem;
}
.more[open] > summary {
  border-bottom: 1px solid var(--rule);
}
.more > :not(summary) {
  margin: 0 0.8rem;
}
.seat-options {
  max-width: 16rem;
}

@media (max-width: 900px) {
  .setup {
    grid-template-columns: minmax(0, 1fr);
  }
  .summary {
    position: static;
    height: auto;
    max-height: none;
    border-left: 0;
    border-top: 1px solid var(--ink);
  }
  .summary-scroll {
    overflow: visible;
  }
}
@media (max-width: 640px) {
  .stage {
    padding: 1.25rem 1rem 2rem;
  }
  .quick {
    grid-template-columns: minmax(0, 1fr);
  }
  .quick-card + .quick-card {
    border-left: 0;
    border-top: 1px solid var(--ink);
  }
  .import-panel {
    grid-template-columns: minmax(0, 1fr);
  }
  .summary-head,
  .summary-scroll,
  .summary-foot {
    padding-left: 1rem;
    padding-right: 1rem;
  }
}
</style>
