<script setup lang="ts">
/**
 * After the game (plan M6 task 1): the result, every decklist, the game's key, and a
 * turn-by-turn replay read from the table's committed snapshots with `replayTurn`.
 */
import { computed, ref, watch } from 'vue';
import { useTableStore } from '../stores/table';

const table = useTableStore();
const results = computed(() => table.results);
const turnIndex = ref(-1);

const turns = computed(() => results.value?.replayTurns ?? []);
watch(
  turns,
  (next) => {
    if (next.length > 0 && turnIndex.value < 0) show(next.length - 1);
  },
  { immediate: true },
);

function show(index: number): void {
  const turn = turns.value[index];
  if (turn === undefined) return;
  turnIndex.value = index;
  table.requestReplayTurn(turn);
}

const endingText = computed(() => {
  const r = results.value;
  if (r === null) return '';
  switch (r.ending) {
    case 'gameOver': {
      const result = r.result;
      if (result === null) return 'The game is over.';
      if (result.endReason === 'timeLimit') return 'The table reached its time limit: a draw.';
      if (result.endReason === 'allAway') return 'Every player was away: a draw.';
      if (result.halted) return 'The game stopped before it was decided.';
      if (result.winnerSeat === null) return 'The game ended in a draw.';
      const name = table.displayNames[result.winnerSeat] ?? result.winnerSeat;
      return `${name} won after ${result.turnCount} turns.`;
    }
    case 'hostAbandoned':
      return 'The host ended the game.';
    case 'workerFailure':
      return 'The game was interrupted by a server fault. The replay shows what was saved.';
    case 'setupFailed':
      return 'The game could not be started.';
    default:
      return '';
  }
});

const board = computed(() => table.replayTurn?.state ?? null);

/** The display title over the ending sentence. */
const headline = computed(() => {
  const r = results.value;
  if (r === null) return 'Game over';
  if (
    r.ending === 'gameOver' &&
    r.result !== null &&
    r.result.winnerSeat !== null &&
    !r.result.halted
  )
    return 'Victory';
  if (r.ending === 'gameOver' && r.result?.halted !== true) return 'A draw';
  return 'Game over';
});

const GROUP_ORDER = ['creatures', 'other', 'lands'] as const;
const GROUP_LABELS: Record<(typeof GROUP_ORDER)[number], string> = {
  creatures: 'Creatures',
  other: 'Other permanents',
  lands: 'Lands',
};

/** One seat of the replayed board, with its permanents in board rows. */
const replaySeats = computed(() => {
  const state = board.value;
  if (state === null) return [];
  return state.seats.map((seat) => {
    const mine = state.battlefield.filter((p) => p.controller === seat.seat);
    return {
      seat,
      name: table.displayNames[seat.seat] ?? seat.seat,
      active: state.activePlayer === seat.seat,
      out: seat.hasLost || state.eliminatedPlayers.includes(seat.seat),
      groups: GROUP_ORDER.map((group) => ({
        group,
        label: GROUP_LABELS[group],
        permanents: mine.filter((p) => (p.boardGroup ?? 'other') === group),
      })).filter((entry) => entry.permanents.length > 0),
    };
  });
});

const deckSize = (deck: { cards: Array<{ quantity: number }> }): number =>
  deck.cards.reduce((sum, card) => sum + card.quantity, 0);
</script>

<template>
  <section v-if="results" class="post-game" data-testid="post-game">
    <header class="head dt-rise">
      <p class="dt-kicker">The table has closed its game</p>
      <h1 class="dt-title">{{ headline }}</h1>
      <div class="dt-ornament" aria-hidden="true"><span class="star" /></div>
      <p class="ending" data-testid="ending">{{ endingText }}</p>
    </header>

    <section
      v-if="turns.length > 0"
      class="replay"
      data-testid="replay"
      aria-labelledby="replay-title"
    >
      <h2 id="replay-title" class="dt-head">
        <span class="num">I.</span> Replay
        <span class="aside"
          >{{ turns.length }} {{ turns.length === 1 ? 'turn' : 'turns' }} saved</span
        >
      </h2>
      <div class="stepper">
        <button
          type="button"
          class="dt-btn small"
          :disabled="turnIndex <= 0"
          data-testid="replay-back"
          @click="show(turnIndex - 1)"
        >
          ◀ Turn
        </button>
        <span class="turn-now" data-testid="replay-turn"
          >Turn {{ table.replayTurn?.turn ?? '…' }}</span
        >
        <button
          type="button"
          class="dt-btn small"
          :disabled="turnIndex >= turns.length - 1"
          data-testid="replay-forward"
          @click="show(turnIndex + 1)"
        >
          Turn ▶
        </button>
      </div>
      <div class="turn-ruler" role="group" aria-label="Go to turn">
        <button
          v-for="(turn, i) in turns"
          :key="turn"
          type="button"
          :class="['tick', { here: i === turnIndex, major: turn % 5 === 0 || i === 0 }]"
          :aria-label="`Show turn ${turn}`"
          :aria-pressed="i === turnIndex"
          @click="show(i)"
        >
          <span v-if="turn % 5 === 0 || i === 0 || i === turns.length - 1" class="tick-num">{{
            turn
          }}</span>
        </button>
      </div>
      <div v-if="board" class="board">
        <article
          v-for="entry in replaySeats"
          :key="entry.seat.seat"
          :class="['seat', { active: entry.active, out: entry.out }]"
        >
          <header class="seat-head">
            <span class="seat-id">{{ entry.seat.seat }}</span>
            <span class="seat-who">
              <strong>{{ entry.name }}</strong>
              <span class="label">{{ entry.seat.label }}</span>
            </span>
            <span class="life" :aria-label="`${entry.seat.life} life`">{{ entry.seat.life }}</span>
          </header>
          <p class="meta">
            {{ entry.seat.hand.length }} in hand · {{ entry.seat.librarySize }} in library ·
            {{ entry.seat.graveyard.length }} in graveyard
            <span v-if="entry.active" class="flag">Active</span>
            <span v-if="entry.out" class="flag out">Out</span>
          </p>
          <div v-for="group in entry.groups" :key="group.group" class="group">
            <span class="dt-kicker">{{ group.label }} · {{ group.permanents.length }}</span>
            <ul>
              <li
                v-for="permanent in group.permanents"
                :key="permanent.id"
                :class="{ tapped: permanent.tapped }"
              >
                <span class="pname">{{ permanent.name }}</span>
                <span v-if="permanent.power !== null" class="pt"
                  >{{ permanent.power }}/{{ permanent.toughness }}</span
                >
              </li>
            </ul>
          </div>
          <p v-if="entry.groups.length === 0" class="empty">No permanents.</p>
        </article>
      </div>
    </section>

    <section class="decks" aria-labelledby="decks-title">
      <h2 id="decks-title" class="dt-head"><span class="num">II.</span> Decklists</h2>
      <div class="deck-grid">
        <details v-for="deck in results.decks" :key="deck.seat" class="deck">
          <summary>
            <span class="seat-id">{{ deck.seat }}</span>
            <span class="deck-who">
              <strong
                >{{ deck.displayName ?? `${deck.seat} (bot)` }} —
                {{ deck.commanderNames.join(' & ') }}</strong
              >
              <span class="label">{{ deckSize(deck) }} cards</span>
            </span>
          </summary>
          <ul>
            <li v-for="card in deck.cards" :key="card.name">
              <span class="qty">{{ card.quantity }}</span> {{ card.name }}
            </li>
          </ul>
        </details>
      </div>
    </section>

    <section v-if="results.rngKey" class="key" aria-labelledby="key-title">
      <h2 id="key-title" class="dt-head"><span class="num">III.</span> Random key</h2>
      <p>Every shuffle and random choice in this game came from this key:</p>
      <code class="dt-plate" data-testid="rng-key">{{ results.rngKey }}</code>
    </section>
  </section>
</template>

<style scoped>
.post-game {
  max-width: 64rem;
  margin: 0 auto;
  padding: 2.5rem 2rem 4rem;
  display: grid;
  gap: 2.5rem;
}
.head {
  display: grid;
  gap: 0.8rem;
  text-align: center;
  justify-items: center;
}
.head .dt-kicker {
  margin: 0;
}
.head .dt-ornament {
  width: min(100%, 28rem);
}
.ending {
  margin: 0;
  font-family: var(--font-body);
  font-size: 1.05rem;
}
.replay,
.decks,
.key {
  display: grid;
  gap: 1rem;
}
.stepper {
  display: flex;
  gap: 1rem;
  align-items: center;
  justify-content: center;
}
.turn-now {
  min-width: 7rem;
  text-align: center;
  font-family: var(--font-display);
  font-size: 1.6rem;
  line-height: 1;
}

/* A ruler with a tick per saved turn; the warm tick is the turn on show. */
.turn-ruler {
  display: flex;
  align-items: flex-end;
  min-height: 2.4rem;
  overflow-x: auto;
  border-bottom: 1px solid var(--ink);
}
.tick {
  position: relative;
  flex: 1 0 14px;
  min-width: 14px;
  height: 2.4rem;
  padding: 0;
  border: 0;
  background: transparent;
}
.tick::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 1px;
  height: 0.45rem;
  background: var(--ink);
  transition:
    height 0.3s var(--ease),
    background-color 0.3s var(--ease),
    width 0.3s var(--ease);
}
.tick.major::after {
  height: 0.8rem;
}
.tick:hover::after {
  height: 1.1rem;
}
.tick.here::after {
  width: 3px;
  margin-left: -1px;
  height: 1.4rem;
  background: var(--warm);
}
.tick:hover:not(:disabled) {
  background: transparent;
}
.tick-num {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--font-body);
  font-size: 0.65rem;
  color: var(--muted);
}
.tick.here .tick-num {
  color: var(--ink);
}

.board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 1rem;
}
.seat {
  display: grid;
  gap: 0.6rem;
  align-content: start;
  padding: 0.9rem 1rem;
  border: 1px solid var(--ink);
  background: var(--paper);
  animation: dtFade 0.4s var(--ease) both;
}
.seat.active {
  box-shadow: inset 0 3px 0 var(--warm);
}
.seat.out {
  opacity: 0.6;
}
.seat-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.7rem;
  align-items: center;
}
.seat-id {
  font-family: var(--font-display);
  font-size: 1.5rem;
  line-height: 1;
}
.seat-who,
.deck-who {
  display: grid;
  min-width: 0;
}
.seat-who strong,
.deck-who strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-body);
  font-weight: 400;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  color: var(--muted);
}
.life {
  font-family: var(--font-display);
  font-size: 2.2rem;
  line-height: 1;
}
.meta {
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.75rem;
  color: var(--muted);
}
.flag {
  margin-left: 0.35rem;
  padding: 0.05rem 0.35rem;
  border: 1px solid var(--ink);
  font-family: var(--font-ui);
  font-size: 0.55rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink);
}
.flag.out {
  border-color: var(--danger);
  color: var(--danger);
}
.group {
  display: grid;
  gap: 0.3rem;
}
.group ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.group li {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  max-width: 100%;
  padding: 0.15rem 0.45rem;
  border: 1px solid var(--rule);
  font-size: 0.75rem;
}
.group li.tapped {
  font-style: italic;
  color: var(--muted);
}
.pname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt {
  font-family: var(--font-body);
  font-size: 0.7rem;
}
.empty {
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
}

.deck-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.75rem;
  align-items: start;
}
.deck {
  border: 1px solid var(--ink);
}
.deck summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.7rem;
  align-items: center;
  padding: 0.7rem 0.9rem;
  cursor: pointer;
  list-style: none;
}
.deck summary::-webkit-details-marker {
  display: none;
}
.deck[open] summary {
  border-bottom: 1px solid var(--ink);
  background: var(--paper-2);
}
.deck ul {
  list-style: none;
  margin: 0;
  padding: 0.6rem 0.9rem;
  max-height: 22rem;
  overflow: auto;
  font-family: var(--font-body);
  font-size: 0.8rem;
  line-height: 1.6;
}
.qty {
  display: inline-block;
  min-width: 1.4rem;
  color: var(--muted);
}
.key p {
  margin: 0;
  font-family: var(--font-body);
}
.key code {
  display: block;
  padding: 0.8rem 1rem;
  word-break: break-all;
  font-size: 0.9rem;
}
@media (max-width: 640px) {
  .post-game {
    padding: 1.5rem 1rem 3rem;
  }
}
</style>
