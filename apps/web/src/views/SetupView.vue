<script setup lang="ts">
/**
 * The new-game screen (brief §10.2, §8), drawn after Decktank `Main.dc.html` and `Deck.dc.html`:
 * the mode compass in the middle, and a setup panel on the right with what this game will be
 * ("This game:"), four tabs (Seats, Bots, Pacing, Extras) and the one Start button.
 *
 * The first visit opens on the compass alone ("Where to?"), with the header and the panel tucked
 * away until a mode is picked (`lib/opening.ts`).
 *
 * There is one setup flow: every option edits the same four seats. Each seat's "Change deck" opens
 * the deck chooser in the compass's place (a generated deck, a modeled deck, a saved deck or your
 * own list), so choosing opponents' decks is the same gesture as choosing your own. A pick takes
 * effect at once so the matchup preview can check it; Cancel puts the seat's old deck back.
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
  PlaybackMode,
  StartGameMode,
  ProviderKind,
  SavedDeckOption,
  SeatSource,
  SetupPreview,
} from '@mtg/shared';
import ManaPips from '../components/ManaPips.vue';
import ModeCompass from '../components/setup/ModeCompass.vue';
import { useConfirmedStart } from '../composables/useConfirmedStart';
import { PROVIDER_LABELS } from '../lib/providerLabels';
import { clearOpened, hasOpened, markOpened, openingScreen } from '../lib/opening';
import { readRecentIds, syncRecentDeckIds } from '../lib/recentSetup';
import { DEFAULT_PACE_MS, useGameStore } from '../stores/game';

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

/**
 * Playback for the game about to start. Live with no wait is a player game's default (the board
 * runs to your next decision); a watched game shows each bot action for a moment. `pace` stays
 * null until moved, so it follows whichever default the mode has.
 */
const playback = ref<PlaybackMode>('live');
const pace = ref<number | null>(null);
const paceValue = computed(
  () => pace.value ?? (gameMode.value === 'singlePlayer' ? 0 : DEFAULT_PACE_MS),
);
function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(2))} s`;
}

/** The opening plate: only the compass and "Where to?" until a mode is picked. */
const opening = ref(!hasOpened());
watch(opening, (value) => (openingScreen.value = value), { immediate: true });
onBeforeUnmount(() => (openingScreen.value = false));

function chooseMode(mode: StartGameMode): void {
  gameMode.value = mode;
  if (opening.value) {
    markOpened();
    opening.value = false;
  }
}
function replayOpening(): void {
  clearOpened();
  pickingSeat.value = null;
  opening.value = true;
}

type Tab = 'seats' | 'bots' | 'pace' | 'extras';
const TABS: ReadonlyArray<[Tab, string]> = [
  ['seats', 'Seats'],
  ['bots', 'Bots'],
  ['pace', 'Pacing'],
  ['extras', 'Extras'],
];
const tab = ref<Tab>('seats');

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

/** The seat whose deck the chooser is changing, if it is open, and the deck it had before. */
const pickingSeat = ref<number | null>(null);
const pickingFrom = ref<SeatChoice | null>(null);
/** Narrows the chooser by commander, deck name or archetype, and by colour identity. */
const deckFilter = ref('');
const colorFilter = ref<Color[]>([]);
/** The list typed under "Bring your own", kept apart until "Check and import". */
const importText = ref('');
const importTag = ref('');
const importEmpty = ref(false);

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

/** Your deck follows you to a new seat, and so does an open chooser. */
watch(humanSeat, (next, previous) => {
  const to = Number(next.slice(1)) - 1;
  const from = Number(previous.slice(1)) - 1;
  const list = choices.value.map((choice, index) =>
    index === to || index === from ? pinGenerated(choice, index) : choice,
  );
  [list[to], list[from]] = [list[from]!, list[to]!];
  choices.value = list;
  if (pickingSeat.value === from) pickingSeat.value = to;
  else if (pickingSeat.value === to) pickingSeat.value = from;
});

function matchesFilter(colors: readonly string[], ...texts: string[]): boolean {
  const needle = deckFilter.value.trim().toLowerCase();
  const text = needle === '' || texts.some((t) => t.toLowerCase().includes(needle));
  return text && colorFilter.value.every((c) => colors.includes(c));
}
const shownKnown = computed(() =>
  knownDecks.value.filter((deck) =>
    matchesFilter(deck.colorIdentity, deck.name, deck.archetypeTag, ...deck.commanderNames),
  ),
);
const orderedSaved = computed(() =>
  saved.value
    .filter((deck) => matchesFilter(deck.colorIdentity, deck.archetypeTag, ...deck.commanderNames))
    .sort((a, b) => {
      const ai = recentDecks.value.indexOf(a.snapshotId);
      const bi = recentDecks.value.indexOf(b.snapshotId);
      return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
    }),
);

function seatName(index: number): string {
  return index === humanIndex.value ? 'you' : `P${index + 1}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A slug such as `token-triumph` as words, for a deck whose file name is its only title. */
function deckTitle(deck: KnownDeck): string {
  return capitalize(deck.name.replace(/[-_]+/g, ' ').trim());
}

/** The deck's title under its commander, unless it only repeats the commander's name. */
function deckSubtitle(deck: KnownDeck): string {
  const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const title = deckTitle(deck);
  return deck.commanderNames.some((name) => plain(name) === plain(title)) ? '' : title;
}

/** A saved deck's name, unless the server only had its commanders to name it by. */
function savedSubtitle(deck: SavedDeckOption): string {
  return deck.name === deck.commanderNames.join(' & ')
    ? 'Saved deck. Imported before.'
    : `Saved · ${deck.name}`;
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
const canStart = computed(
  () => current.value !== null && current.value.blockers.length === 0 && !starting.value,
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

/** A typed seed waits longer, so it is not fetched once per keystroke. */
function schedulePreview(): void {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreview(), customSeed.value !== '' ? 700 : 150);
}

watch(
  requestKey,
  () => {
    clearStartErrors();
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

/** Opens the chooser for one seat (or moves it there), remembering the deck to go back to. */
function openChooser(index: number): void {
  if (pickingSeat.value !== index) {
    pickingSeat.value = index;
    pickingFrom.value = choices.value[index]!;
    const choice = choices.value[index]!;
    importText.value = choice.kind === 'import' ? choice.text : '';
    importTag.value = choice.kind === 'import' ? choice.tag : '';
    importEmpty.value = false;
  }
}
function cancelChooser(): void {
  if (pickingSeat.value !== null && pickingFrom.value !== null)
    setChoice(pickingSeat.value, pickingFrom.value);
  pickingSeat.value = null;
}
function useDeck(): void {
  pickingSeat.value = null;
}
const pickingChoice = computed(() =>
  pickingSeat.value === null ? null : choices.value[pickingSeat.value]!,
);

function pickKnown(slug: string): void {
  if (pickingSeat.value !== null) setChoice(pickingSeat.value, { kind: 'known', slug });
}
function pickSaved(snapshotId: string): void {
  if (pickingSeat.value !== null) setChoice(pickingSeat.value, { kind: 'saved', snapshotId });
}
/** A generated deck. A seat that already has one keeps it: there is no reroll. */
function pickGenerated(): void {
  if (pickingSeat.value === null || pickingChoice.value?.kind === 'pool') return;
  setChoice(pickingSeat.value, { kind: 'pool', seed: null });
}
/** "Check and import": the list goes to the seat, and the matchup preview checks it. */
function checkImport(): void {
  if (pickingSeat.value === null) return;
  importEmpty.value = importText.value.trim() === '';
  if (importEmpty.value) return;
  setChoice(pickingSeat.value, { kind: 'import', text: importText.value, tag: importTag.value });
}

/** The chooser's import, once checked: still checking, refused with reasons, or in. */
const importState = computed(() => {
  const index = pickingSeat.value;
  if (index === null || pickingChoice.value?.kind !== 'import') return null;
  const seat = current.value?.seats[index];
  if (seat === undefined) return previewError.value !== '' ? null : { kind: 'checking' as const };
  if (!seat.modeled) return { kind: 'stopped' as const, reasons: current.value?.blockers ?? [] };
  return { kind: 'in' as const, name: seat.commanderNames.join(' & ') };
});

/** The chooser's rows: "a." onward through every section, as the design letters them. */
const rowLetters = computed(() => {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const known = shownKnown.value.map((_, i) => letters[(i + 1) % 26]!);
  const savedLetters = orderedSaved.value.map((_, i) => letters[(i + 1 + known.length) % 26]!);
  return { known, saved: savedLetters };
});

const COLORS: ReadonlyArray<[Color, string]> = [
  ['W', 'White'],
  ['U', 'Blue'],
  ['B', 'Black'],
  ['R', 'Red'],
  ['G', 'Green'],
];
function toggleColor(color: Color): void {
  colorFilter.value = colorFilter.value.includes(color)
    ? colorFilter.value.filter((c) => c !== color)
    : [...colorFilter.value, color];
}

/** Who plays a seat: you (in Play) or a bot. Making your seat a bot moves you to the next one. */
function setSeatPlayer(index: number, you: boolean): void {
  const id = SEAT_IDS[index]!;
  if (you) humanSeat.value = id;
  else if (humanSeat.value === id) humanSeat.value = SEAT_IDS[(index + 1) % SEATS]!;
}

function start(): void {
  const matchup = current.value;
  if (!matchup || matchup.blockers.length > 0) return;
  // The start redeems this preview, so it must not be offered again. A refused start brings a
  // fresh one through the `startErrors` watch.
  preview.value = null;
  store.playbackMode = playback.value;
  store.paceMs = paceValue.value;
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

/** The display title under the compass (the page's `<h1>` keeps "New game" for readers). */
const modeTitle = computed(() =>
  opening.value
    ? 'Where to?'
    : gameMode.value === 'singlePlayer'
      ? 'Play against bots'
      : 'Watch four bots',
);

const WORDS = ['No', 'One', 'Two', 'Three', 'Four'];
const botCount = computed(() => (gameMode.value === 'singlePlayer' ? 3 : 4));
const botsText = computed(
  () => `${WORDS[botCount.value]} ${providerKind.value === 'ai' ? 'AI' : 'built-in'} bots`,
);
const playbackText = computed(() =>
  playback.value === 'manual'
    ? 'Step by hand'
    : paceValue.value === 0
      ? 'Live, no wait between bot actions'
      : `Live, ${seconds(paceValue.value)} per action`,
);
const shuffleText = computed(() =>
  customSeed.value.trim() !== '' ? `Seed ${customSeed.value.trim()}` : 'New random shuffle',
);

/** "This game:" — the whole setup in five lines, as the design's plate reads it. */
const plate = computed(() =>
  gameMode.value === 'singlePlayer'
    ? [
        {
          k: 'You',
          v: `Seat ${humanSeat.value}, ${
            choices.value[humanIndex.value]?.kind === 'pool'
              ? 'generated deck'
              : (seatRows.value[humanIndex.value]?.title ?? '')
          }`,
        },
        { k: 'Opponents', v: botsText.value },
        { k: 'Playback', v: playbackText.value },
        { k: 'Shuffle', v: shuffleText.value },
        { k: 'Table talk', v: diplomacy.value ? 'On, bots can offer you deals' : 'Off' },
      ]
    : [
        { k: 'Players', v: botsText.value },
        { k: 'You see', v: 'Every hand, every turn' },
        { k: 'Playback', v: playbackText.value },
        { k: 'Shuffle', v: shuffleText.value },
        { k: 'Table talk', v: diplomacy.value ? 'On' : 'Off' },
      ],
);

/**
 * One seat's card: the preview's answer when it has one, else the choice. A blocked seat shows
 * only the choice, never the preview's names: those came from a list nothing has validated, and
 * three of the four seats are opponents.
 */
const seatRows = computed(() =>
  choices.value.map((choice, index) => {
    const seat = current.value?.seats[index];
    const shown = seat?.modeled === true ? seat : undefined;
    const you = index === humanIndex.value;
    return {
      index,
      id: SEAT_IDS[index]!,
      you,
      band: pickingSeat.value === index ? 'Choosing a deck' : you ? 'Your seat' : '',
      controller: you ? 'You' : providerKind.value === 'ai' ? 'AI bot' : 'Built-in bot',
      title: shown?.commanderNames.join(' & ') || choiceLabel(choice),
      colors: shown?.colorIdentity ?? null,
      archetype: shown?.archetypeTag ?? '',
      note:
        choice.kind === 'pool'
          ? you
            ? 'Your deck. Built when the game starts.'
            : 'Built when the game starts.'
          : choice.kind === 'saved'
            ? 'Your saved deck.'
            : choice.kind === 'import'
              ? 'Your own list.'
              : 'Modeled deck. Every card supported.',
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
    };
  }),
);
const pickingRow = computed(() =>
  pickingSeat.value === null ? null : seatRows.value[pickingSeat.value]!,
);
</script>

<template>
  <div class="setup" :class="{ opening, picking: pickingSeat !== null }">
    <section class="stage" :aria-labelledby="pickingSeat === null ? 'mode-title' : 'deck-title'">
      <template v-if="pickingSeat === null">
        <ModeCompass
          :model-value="gameMode"
          :opening="opening"
          :disabled="starting"
          @choose="chooseMode"
        />
        <div class="title-g">
          <h1 id="mode-title" :key="modeTitle" class="mode-title">
            <span class="dt-sr">New game: </span>{{ modeTitle }}
          </h1>
          <button v-if="!opening" type="button" class="replay" @click="replayOpening">
            [ Replay opening ]
          </button>
        </div>
      </template>

      <!-- Choosing a deck takes the compass's place until you cancel or use the deck. -->
      <section
        v-else
        class="chooser"
        role="group"
        :aria-label="`Decks for ${seatName(pickingSeat)}`"
      >
        <div class="chooser-scroll">
          <div class="chooser-head">
            <div class="chooser-title">
              <h1 id="deck-title" class="dt-title">Choose a deck</h1>
              <span class="title-rule" aria-hidden="true">
                <span class="rule"></span>
                <svg width="12" height="12" viewBox="0 0 14 14">
                  <path d="M7 0 L8 6 L14 7 L8 8 L7 14 L6 8 L0 7 L6 6 Z" fill="currentColor" />
                </svg>
              </span>
              <p class="lead">
                Every deck listed here plays without stalling. Pick one for seat
                {{ SEAT_IDS[pickingSeat] }}, or paste your own list at the end.
              </p>
            </div>
            <div class="for-seat">
              <span class="field-label">For seat</span>
              <div role="group" aria-label="Seat" class="square-seg">
                <button
                  v-for="(id, index) in SEAT_IDS"
                  :key="id"
                  type="button"
                  :aria-pressed="pickingSeat === index"
                  :aria-label="`Seat ${id}`"
                  @click="openChooser(index)"
                >
                  {{ id }}
                </button>
              </div>
            </div>
          </div>

          <div class="filters">
            <label class="find">
              <span class="field-label">Find a commander</span>
              <input v-model="deckFilter" type="search" placeholder="Type a name" />
            </label>
            <div role="group" aria-label="Colour identity" class="colours">
              <span class="field-label">Colours</span>
              <div class="colour-row">
                <button
                  v-for="[c, name] in COLORS"
                  :key="c"
                  type="button"
                  class="colour"
                  :class="`colour-${c}`"
                  :aria-pressed="colorFilter.includes(c)"
                  :aria-label="name"
                  @click="toggleColor(c)"
                >
                  {{ c }}
                </button>
              </div>
            </div>
          </div>

          <section class="deck-group">
            <div class="group-head">
              <h2>I. Generated</h2>
              <span class="note">Different every time.</span>
            </div>
            <ul>
              <li>
                <button
                  type="button"
                  class="deck-row"
                  :aria-pressed="pickingChoice?.kind === 'pool'"
                  @click="pickGenerated"
                >
                  <span class="letter" aria-hidden="true">a.</span>
                  <span class="row-text">
                    <span class="row-name">Generated deck</span>
                    <span class="row-sub"
                      >Built fresh from fully supported cards when the game starts.</span
                    >
                  </span>
                  <span class="row-end">
                    <span class="mark" aria-hidden="true">{{
                      pickingChoice?.kind === 'pool' ? '★' : ''
                    }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>

          <section class="deck-group">
            <div class="group-head">
              <h2>II. Modeled decks</h2>
              <span class="note">{{ shownKnown.length }} of {{ knownDecks.length }} shown.</span>
            </div>
            <p v-if="!knownDecksLoaded" class="hint">Loading modeled decks…</p>
            <p v-if="knownDecksError !== null" class="dt-note danger">
              Modeled decks unavailable: {{ knownDecksError }}
            </p>
            <ul>
              <li v-for="(deck, i) in shownKnown" :key="deck.slug">
                <button
                  type="button"
                  class="deck-row"
                  :aria-pressed="
                    pickingChoice?.kind === 'known' && pickingChoice.slug === deck.slug
                  "
                  :disabled="!persistence"
                  :title="deckTitle(deck)"
                  @click="pickKnown(deck.slug)"
                >
                  <span class="letter" aria-hidden="true">{{ rowLetters.known[i] }}.</span>
                  <span class="row-text">
                    <span class="row-name">{{ deck.commanderNames.join(' & ') }}</span>
                    <span class="row-sub">{{
                      deckSubtitle(deck)
                        ? `${deckSubtitle(deck)}. Every card supported.`
                        : 'Modeled deck. Every card supported.'
                    }}</span>
                  </span>
                  <span class="row-end">
                    <ManaPips :colors="deck.colorIdentity" />
                    <span class="row-tag">{{ deck.archetypeTag }}</span>
                    <span class="mark" aria-hidden="true">{{
                      pickingChoice?.kind === 'known' && pickingChoice.slug === deck.slug ? '★' : ''
                    }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>

          <section class="deck-group">
            <div class="group-head">
              <h2>III. Your saved decks</h2>
              <span class="note">Decks you imported before.</span>
            </div>
            <p v-if="!persistence" class="hint">
              Saved and imported decks are disabled without a database. Generated decks remain
              available.
            </p>
            <p v-else-if="saved.length === 0" class="hint">
              Nothing saved yet. A list you bring below is kept here after its first game.
            </p>
            <ul>
              <li v-for="(deck, i) in orderedSaved" :key="deck.snapshotId">
                <button
                  type="button"
                  class="deck-row"
                  :aria-pressed="
                    pickingChoice?.kind === 'saved' && pickingChoice.snapshotId === deck.snapshotId
                  "
                  @click="pickSaved(deck.snapshotId)"
                >
                  <span class="letter" aria-hidden="true">{{ rowLetters.saved[i] }}.</span>
                  <span class="row-text">
                    <span class="row-name">{{ deck.commanderNames.join(' & ') }}</span>
                    <span class="row-sub">{{ savedSubtitle(deck) }}</span>
                  </span>
                  <span class="row-end">
                    <ManaPips :colors="deck.colorIdentity" />
                    <span class="row-tag">{{ deck.archetypeTag }}</span>
                    <span class="mark" aria-hidden="true">{{
                      pickingChoice?.kind === 'saved' &&
                      pickingChoice.snapshotId === deck.snapshotId
                        ? '★'
                        : ''
                    }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>

          <section class="deck-group own">
            <div class="group-head">
              <h2>IV. Bring your own</h2>
              <span class="note">Moxfield, Archidekt, or a pasted list.</span>
            </div>
            <label class="own-field">
              <span class="field-label">Deck link or decklist</span>
              <textarea
                v-model="importText"
                rows="4"
                :disabled="!persistence"
                placeholder="https://moxfield.com/decks/… or one card per line"
              ></textarea>
            </label>
            <!-- Leaving this blank is the normal path: the server classifies the resolved list
                 (ADR 0022 §5). Anything typed here wins outright and is never overwritten. -->
            <label class="own-field tag">
              <span class="field-label">Archetype (optional)</span>
              <input
                v-model="importTag"
                type="text"
                :disabled="!persistence"
                placeholder="Worked out for you if blank"
              />
            </label>
            <button
              type="button"
              class="dt-btn check"
              :disabled="!persistence"
              @click="checkImport"
            >
              Check and import
            </button>
            <p v-if="importEmpty" role="status" class="hint">Paste a deck link or a list first.</p>
            <p v-else-if="importState?.kind === 'checking'" role="status" class="hint">
              Checking every card against the rules engine…
            </p>
            <p v-else-if="importState?.kind === 'in'" role="status" class="import-in">
              {{ importState.name }} is in. Every card is supported.
            </p>
            <div v-else-if="importState?.kind === 'stopped'" role="status" class="import-stopped">
              <div class="stopped-head">
                <span class="field-label">Import stopped</span>
                <span>This list can't be used yet:</span>
              </div>
              <ul>
                <li v-for="reason in importState.reasons" :key="reason">{{ reason }}</li>
              </ul>
              <div class="stopped-foot">
                <span>The Card lab shows which cards still need work in the rules engine.</span>
                <RouterLink to="/card-test-lab" class="dt-btn small"
                  >Open in Card lab<span class="dt-arr" aria-hidden="true"
                /></RouterLink>
              </div>
            </div>
          </section>
        </div>

        <div class="chooser-foot">
          <p>
            Seat {{ SEAT_IDS[pickingSeat] }}:
            <span class="pick-name">{{ pickingRow?.title }}</span>
          </p>
          <div class="foot-actions">
            <button type="button" class="link-btn" @click="cancelChooser">[ Cancel ]</button>
            <button type="button" class="dt-btn-primary" @click="useDeck">
              Use this deck<span class="dt-arr" aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
    </section>

    <aside
      class="summary"
      aria-label="Set up"
      :aria-hidden="opening ? 'true' : undefined"
      :inert="opening"
    >
      <div class="plate">
        <span class="field-label">This game:</span>
        <ul :key="gameMode">
          <li v-for="(row, i) in plate" :key="row.k" :style="{ animationDelay: `${0.05 * i}s` }">
            <span class="plate-k">{{ row.k }}</span>
            <span class="plate-v">{{ row.v }}</span>
          </li>
        </ul>
      </div>

      <div role="group" aria-label="Setup sections" class="tabs">
        <button
          v-for="[key, label] in TABS"
          :key="key"
          type="button"
          :aria-pressed="tab === key"
          @click="tab = key"
        >
          {{ label }}
        </button>
      </div>

      <div :key="tab" class="summary-scroll">
        <!-- Seats: two by two. -->
        <ul
          v-show="tab === 'seats'"
          class="seats"
          aria-label="Matchup preview"
          :aria-busy="previewBusy"
        >
          <li
            v-for="row in seatRows"
            :key="row.id"
            class="seat"
            :class="{ human: row.you, choosing: pickingSeat === row.index }"
          >
            <span class="band">{{ row.band }}</span>
            <div class="seat-body">
              <div class="seat-head">
                <span class="seat-id" aria-hidden="true">{{ row.id }}</span>
                <span class="seat-text">
                  <span class="dt-sr">{{ row.id }} · {{ row.controller }}: </span>
                  <strong class="seat-title">{{ row.title }}</strong>
                  <span
                    class="status"
                    :class="{
                      ok: row.status === 'Fully modeled',
                      bad: row.status.startsWith('Blocked'),
                    }"
                    >{{ row.status }}</span
                  >
                </span>
              </div>
              <span v-if="row.colors || row.archetype" class="seat-note seat-meta">
                <ManaPips v-if="row.colors" :colors="row.colors" />
                <span v-if="row.archetype">{{ row.archetype }}</span>
              </span>
              <span v-else class="seat-note">{{ row.note }}</span>
              <button
                type="button"
                class="dt-btn change"
                :aria-label="`Change the deck for ${row.id}`"
                :aria-expanded="pickingSeat === row.index"
                @click="openChooser(row.index)"
              >
                Change deck<span class="dt-arr" aria-hidden="true" />
              </button>
            </div>
          </li>
        </ul>

        <div v-if="tab === 'bots'" role="group" aria-label="The bots" class="options">
          <div v-if="gameMode === 'singlePlayer'" class="option">
            <span class="option-label">Who plays each seat</span>
            <div class="seat-ctrls">
              <div v-for="(id, index) in SEAT_IDS" :key="id" class="seat-ctrl">
                <span class="seat-ctrl-id" aria-hidden="true">{{ id }}</span>
                <div role="group" :aria-label="`Who plays seat ${id}`" class="dt-seg">
                  <button
                    type="button"
                    :aria-pressed="humanSeat === id"
                    title="You play this seat"
                    @click="setSeatPlayer(index, true)"
                  >
                    You
                  </button>
                  <button
                    type="button"
                    :aria-pressed="humanSeat !== id"
                    title="A bot plays this seat"
                    @click="setSeatPlayer(index, false)"
                  >
                    Bot
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="option">
            <span class="option-label">Bots</span>
            <div role="group" aria-label="Bots" class="dt-seg fit">
              <button
                type="button"
                :aria-pressed="providerKind === 'random'"
                title="Rule-based bots: fast, free, and fully seeded"
                @click="providerKind = 'random'"
              >
                {{ PROVIDER_LABELS.random }}
              </button>
              <button
                type="button"
                :aria-pressed="providerKind === 'ai'"
                title="Language-model bots: slower, and they spend API budget"
                @click="providerKind = 'ai'"
              >
                {{ PROVIDER_LABELS.ai }}
              </button>
            </div>
            <p class="hint">
              {{
                providerKind === 'ai'
                  ? 'Strategic bot decisions. May spend API budget.'
                  : 'Rule-based bots: fast, free, and fully seeded.'
              }}
            </p>
          </div>
          <div class="option" :class="{ off: providerKind !== 'ai' }">
            <span class="option-label">Post-game commentary</span>
            <label class="toggle">
              <input
                v-model="reflectionEnabled"
                type="checkbox"
                :disabled="providerKind !== 'ai'"
              />
              Write a review after the game
              <span v-if="providerKind !== 'ai'" class="off-note">Needs AI bots</span>
            </label>
          </div>
        </div>

        <div v-if="tab === 'pace'" role="group" aria-label="Pacing" class="options">
          <div class="option">
            <span class="option-label">Playback</span>
            <div role="group" aria-label="Playback" class="dt-seg fit">
              <button type="button" :aria-pressed="playback === 'live'" @click="playback = 'live'">
                Live
              </button>
              <button
                type="button"
                :aria-pressed="playback === 'manual'"
                @click="playback = 'manual'"
              >
                Step by hand
              </button>
            </div>
            <p class="hint">
              {{
                playback === 'live'
                  ? 'Bots move on their own; you can pause and scrub at any time.'
                  : 'Nothing moves until you step forward.'
              }}
            </p>
          </div>
          <div class="option" :class="{ off: playback !== 'live' }">
            <span class="option-label">Pace</span>
            <label class="range">
              <input
                type="range"
                min="0"
                max="3000"
                step="250"
                aria-label="Pace"
                :value="paceValue"
                :disabled="playback !== 'live'"
                @input="pace = Number(($event.target as HTMLInputElement).value)"
              />
              <span>{{
                playback !== 'live'
                  ? 'Off while stepping by hand'
                  : paceValue === 0
                    ? 'No wait between bot actions'
                    : `${seconds(paceValue)} between bot actions`
              }}</span>
            </label>
          </div>
        </div>

        <div
          v-if="tab === 'extras'"
          role="group"
          aria-label="Table talk and shuffle"
          class="options"
        >
          <div class="option">
            <span class="option-label">Table talk and deals</span>
            <label class="toggle">
              <input v-model="diplomacy" type="checkbox" />
              {{ diplomacy ? 'On' : 'Off' }}
            </label>
            <p class="hint">
              {{
                gameMode === 'singlePlayer'
                  ? 'Bots point out threats and can offer you short deals.'
                  : 'Bots point out threats and make short deals with each other.'
              }}
            </p>
          </div>
          <div class="option">
            <label class="option-label" for="replay-seed">Replay seed</label>
            <input
              id="replay-seed"
              v-model="customSeed"
              type="text"
              class="seed-input"
              placeholder="Blank for a new shuffle"
            />
            <p class="hint">
              Type a seed from an earlier game to deal the same shuffle again. AI decisions may
              still vary.
            </p>
          </div>
        </div>
      </div>

      <div class="notes">
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
        <div v-if="startErrors.length > 0" class="dt-note danger" role="alert">
          <strong>The game did not start</strong>
          <ul>
            <li v-for="(error, index) in startErrors" :key="index">{{ error }}</li>
          </ul>
        </div>
      </div>

      <div class="summary-foot">
        <button type="button" class="dt-btn-primary wide" :disabled="!canStart" @click="start">
          <span :key="gameMode" class="verb">{{
            starting ? 'Starting…' : gameMode === 'singlePlayer' ? 'Start game' : 'Start watching'
          }}</span
          ><span class="dt-arr" aria-hidden="true" />
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.setup {
  --aside-w: 30rem;
  position: relative;
  font-family: var(--font-body);
  height: 100%;
  min-height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(20rem, var(--aside-w));
  overflow: hidden;
  font-size: 14px;
}
p {
  margin: 0;
}
.hint {
  color: var(--muted);
  font-size: 0.725rem;
  line-height: 1.6;
}
.dt-note {
  white-space: pre-wrap;
}
.dt-note .retry {
  margin-top: 0.5rem;
}
.field-label,
.option-label {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* The stage: the compass and the mode's title, or the deck chooser. */
.stage {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 1.25rem;
  padding: 1.5rem 2.5rem;
  transition: transform 1s var(--ease);
}
.setup.opening {
  overflow: visible;
}
.opening .stage {
  transform: translate3d(calc(var(--aside-w) / 2), 0, 0);
}
.title-g {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  max-width: 40rem;
  text-align: center;
  transition: transform 1s var(--ease);
}
.opening .title-g {
  transform: translate3d(0, calc(min(64vh, 680px) * 0.16), 0);
}
.mode-title {
  margin: 0;
  min-height: 1.9em;
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(2.4rem, 4.2vw, 4.4rem);
  line-height: 0.95;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  animation: dtRise 0.7s var(--ease) both;
}
.opening .mode-title {
  animation-delay: 0.3s;
  text-shadow:
    0 0 6px var(--paper),
    0 0 12px var(--paper),
    0 0 18px var(--paper),
    0 0 24px var(--paper);
}
.replay,
.link-btn {
  min-height: 44px;
  padding: 0 0.5rem;
  border: 0;
  background: none;
  color: var(--muted);
  font-family: var(--font-body);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  cursor: pointer;
}
.replay {
  animation: dtFade 0.6s var(--ease) 0.6s both;
}
.link-btn {
  color: var(--ink);
  font-size: 0.9rem;
  letter-spacing: 0;
}

/* The deck chooser (Deck.dc.html), in the compass's place. */
.chooser {
  align-self: stretch;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  max-width: 54rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  animation: dtRise 0.55s var(--ease) both;
}
.chooser-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2rem;
  padding: 0.75rem 0.25rem 2rem;
}
.chooser-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem 2rem;
}
.chooser-title {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: fit-content;
  max-width: 100%;
}
.chooser-title .dt-title {
  font-size: clamp(2.4rem, 4vw, 3.6rem);
}
.title-rule {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}
.title-rule .rule {
  flex: 1;
  height: 1px;
  background: var(--ink);
  transform-origin: right center;
  animation: dtRule 0.9s var(--ease) 0.2s both;
}
.title-rule svg {
  animation: dtTick 0.6s var(--ease) 0.5s both;
}
.lead {
  max-width: 34rem;
  font-size: 0.9rem;
  line-height: 1.6;
}
.for-seat,
.colours,
.find {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.square-seg {
  display: flex;
  padding-left: 1px;
}
.square-seg button,
.colour {
  min-width: 44px;
  min-height: 44px;
  margin-left: -1px;
  border: 1px solid var(--ink);
  background: transparent;
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 0.3s var(--ease),
    color 0.3s var(--ease);
}
.square-seg button[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 1.25rem 3rem;
}
.find {
  flex: 1 1 16rem;
}
.find input {
  min-height: 44px;
  padding: 0.5rem 0;
  border: 0;
  border-bottom: 1px solid var(--ink);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 1rem;
}
.find input:focus {
  outline: none;
  border-bottom-width: 2px;
}
.colour-row {
  display: flex;
  gap: 0.5rem;
}
.colour {
  margin-left: 0;
  font-size: 1.05rem;
}
.colour-W {
  background: var(--mana-w-tint);
}
.colour-U {
  background: var(--mana-u-tint);
}
.colour-B {
  background: var(--mana-b-tint);
}
.colour-R {
  background: var(--mana-r-tint);
}
.colour-G {
  background: var(--mana-g-tint);
}
.colour[aria-pressed='true'] {
  border-width: 3px;
}
.colour-W[aria-pressed='true'] {
  background: var(--mana-w);
}
.colour-U[aria-pressed='true'] {
  background: var(--mana-u);
}
.colour-B[aria-pressed='true'] {
  background: var(--mana-b);
  color: var(--mana-b-letter);
}
.colour-R[aria-pressed='true'] {
  background: var(--mana-r);
}
.colour-G[aria-pressed='true'] {
  background: var(--mana-g);
}
.deck-group {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.deck-group ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}
.deck-group li {
  border-bottom: 1px solid var(--ink);
}
.group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem 2rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--ink);
}
.group-head h2 {
  margin: 0;
  font-family: var(--font-body);
  font-size: 1.05rem;
  font-weight: 400;
  line-height: 1.2;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.note {
  font-size: 0.725rem;
  line-height: 1.85;
  color: var(--muted);
}
.deck-row {
  width: 100%;
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem;
  border: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.3s var(--ease);
}
.deck-row:hover:not(:disabled),
.deck-row[aria-pressed='true'] {
  background: var(--paper-2);
}
.deck-row:disabled {
  opacity: 0.45;
  cursor: default;
}
.letter {
  font-size: 0.725rem;
  letter-spacing: 0.09em;
  color: var(--muted);
}
.row-text {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}
.row-name {
  font-size: 0.9rem;
  line-height: 1.5;
}
.row-sub {
  font-size: 0.725rem;
  line-height: 1.6;
  color: var(--muted);
}
.row-end {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.row-tag {
  min-width: 6rem;
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-align: right;
  text-transform: uppercase;
}
.mark {
  width: 1rem;
  font-size: 0.9rem;
  line-height: 1;
  text-align: center;
}
.own {
  gap: 1rem;
}
.own-field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 40rem;
}
.own-field textarea {
  padding: 0.75rem;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper-2);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.9rem;
  line-height: 1.6;
  resize: vertical;
}
.own-field.tag {
  max-width: 16rem;
}
.own-field input,
.seed-input {
  max-width: 18rem;
  padding: 0.4rem 0;
  border: 0;
  border-bottom: 1px solid var(--ink);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.9rem;
}
.check {
  align-self: flex-start;
}
.import-in {
  font-size: 0.85rem;
  color: var(--ok);
}
.import-stopped {
  max-width: 40rem;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ink);
  animation: dtRise 0.45s var(--ease) both;
}
.stopped-head {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.9rem 1rem;
  font-size: 0.9rem;
  line-height: 1.5;
}
.import-stopped ul {
  margin: 0;
  padding: 0 1rem;
  list-style: none;
  border-top: 1px solid var(--ink);
}
.import-stopped li {
  padding: 0.45rem 0;
  border-bottom: 1px solid var(--rule);
  font-size: 0.8rem;
  white-space: pre-wrap;
}
.stopped-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1rem;
  padding: 0.9rem 1rem;
  background: var(--paper-2);
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--muted);
}
.chooser-foot {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 2rem;
  padding: 0.75rem 1.25rem;
  border: 1px solid var(--ink);
  background: var(--paper-2);
}
.chooser-foot p {
  min-width: 0;
  font-size: 0.9rem;
  line-height: 1.6;
}
.pick-name {
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.foot-actions {
  display: flex;
  align-items: center;
  gap: 1.25rem;
}
.foot-actions .dt-btn-primary {
  min-height: 44px;
  font-size: 0.75rem;
}

/* The setup panel: what this game is, four tabs, and Start. */
.summary {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
  border-left: 1px solid var(--ink);
  background: var(--paper);
  transition:
    opacity 0.7s var(--ease) 0.35s,
    transform 1s var(--ease),
    border-color 0.6s linear 0.3s;
}
.opening .summary {
  opacity: 0;
  border-color: transparent;
  transform: translate3d(100%, 0, 0);
  pointer-events: none;
  transition: none;
}
.plate {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1.25rem 1.75rem 1rem;
  border-bottom: 1px solid var(--ink);
}
.plate ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}
.plate li {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.3rem 0;
  border-bottom: 1px solid var(--ink);
  animation: dtRise 0.5s var(--ease) both;
}
.plate-k {
  flex: 0 0 6.5rem;
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.plate-v {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 0.8rem;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tabs {
  flex: 0 0 auto;
  display: flex;
  border-bottom: 1px solid var(--ink);
}
.tabs button {
  flex: 1;
  min-height: 44px;
  border: 0;
  border-right: 1px solid var(--ink);
  background: transparent;
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    background-color 0.3s var(--ease),
    color 0.3s var(--ease);
}
.tabs button:last-child {
  border-right: 0;
}
.tabs button[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
.summary-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 1rem 1.75rem;
  animation: dtFade 0.45s var(--ease) both;
}
.seats {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12.5rem, 1fr));
  border-top: 1px solid var(--ink);
  border-left: 1px solid var(--ink);
}
.seat {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--ink);
  border-bottom: 1px solid var(--ink);
}
.band {
  min-height: 0.9rem;
  padding: 0.25rem 0.9rem;
  background: transparent;
  color: var(--paper);
  font-family: var(--font-ui);
  font-size: 0.65rem;
  line-height: 0.9rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.seat.human .band,
.seat.choosing .band {
  background: var(--ink);
}
.seat-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: 0.5rem 0.9rem 0.6rem;
}
.seat-head {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}
.seat-id {
  flex: 0 0 auto;
  font-family: var(--font-display);
  font-size: 2.1rem;
  line-height: 1;
}
.seat-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.seat-title {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  font-family: var(--font-body);
  font-size: 0.8rem;
  font-weight: 400;
  line-height: 1.35;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.status {
  font-size: 0.6rem;
  line-height: 1.8;
  letter-spacing: 0.09em;
  color: var(--muted);
}
.status.ok {
  color: var(--ok);
}
.status.bad {
  color: var(--danger);
}
.seat-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.2rem 0.5rem;
}
.seat-note {
  font-size: 0.725rem;
  line-height: 1.6;
  color: var(--muted);
}
.change {
  margin-top: auto;
  justify-content: space-between;
  width: 100%;
  min-height: 38px;
}
.options {
  display: flex;
  flex-direction: column;
}
.option {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1.1rem 0;
  border-bottom: 1px solid var(--ink);
}
.option .option-label {
  font-size: 0.8rem;
}
.option.off .option-label,
.option.off .toggle {
  color: var(--muted);
}
.seat-ctrls {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.seat-ctrl {
  display: grid;
  grid-template-columns: 2.4rem minmax(0, 1fr);
  gap: 0.75rem;
  align-items: center;
}
.seat-ctrl-id {
  font-family: var(--font-display);
  font-size: 1.6rem;
  line-height: 1;
}
.dt-seg > button {
  min-height: 36px;
}
.dt-seg.fit > button {
  flex: 0 0 auto;
  padding: 0 0.9rem;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 36px;
  font-size: 0.9rem;
  cursor: pointer;
}
.toggle input {
  width: 1.1rem;
  height: 1.1rem;
  margin: 0;
  accent-color: var(--ink);
}
.off-note {
  margin-left: auto;
  font-family: var(--font-ui);
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}
.range {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  font-size: 0.8rem;
}
.range input {
  flex: 1 1 10rem;
  accent-color: var(--ink);
}
.notes {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0 1.75rem;
}
.notes:has(> *) {
  padding-bottom: 0.75rem;
}
.summary-foot {
  flex: 0 0 auto;
  padding: 1rem 1.75rem;
  border-top: 1px solid var(--ink);
  background: var(--paper-2);
}
.verb {
  animation: dtFade 0.5s var(--ease) both;
}

@media (max-width: 900px) {
  .setup {
    height: auto;
    min-height: 100%;
    grid-template-columns: minmax(0, 1fr);
    overflow: visible;
  }
  .opening .stage,
  .opening .title-g {
    transform: none;
  }
  .opening .stage {
    justify-content: center;
  }
  .opening .summary {
    display: none;
  }
  .stage {
    overflow: hidden;
  }
  .summary {
    max-height: none;
    border-left: 0;
    border-top: 1px solid var(--ink);
  }
  .summary-scroll {
    flex: 0 0 auto;
    height: 31rem;
  }
}
@media (max-width: 760px) {
  .stage {
    padding: 1.25rem 1rem;
  }
  .plate,
  .summary-scroll,
  .notes,
  .summary-foot {
    padding-left: 1rem;
    padding-right: 1rem;
  }
  .deck-row {
    grid-template-columns: 1rem minmax(0, 1fr) auto;
    gap: 0.5rem;
    padding: 0.7rem 0.4rem;
  }
  .row-tag {
    min-width: 0;
  }
}
</style>
