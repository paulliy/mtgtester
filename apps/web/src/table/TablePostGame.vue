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
</script>

<template>
  <section v-if="results" class="post-game" data-testid="post-game">
    <h2>Game over</h2>
    <p data-testid="ending">{{ endingText }}</p>

    <section v-if="turns.length > 0" class="replay" data-testid="replay">
      <h3>Replay</h3>
      <div class="stepper">
        <button
          type="button"
          :disabled="turnIndex <= 0"
          data-testid="replay-back"
          @click="show(turnIndex - 1)"
        >
          ◀ Turn
        </button>
        <span data-testid="replay-turn">Turn {{ table.replayTurn?.turn ?? '…' }}</span>
        <button
          type="button"
          :disabled="turnIndex >= turns.length - 1"
          data-testid="replay-forward"
          @click="show(turnIndex + 1)"
        >
          Turn ▶
        </button>
      </div>
      <div v-if="board" class="board">
        <div v-for="seat in board.seats" :key="seat.seat" class="seat">
          <strong>{{ table.displayNames[seat.seat] ?? seat.seat }}</strong>
          <span>{{ seat.life }} life · {{ seat.hand.length }} in hand</span>
          <ul>
            <li
              v-for="permanent in board.battlefield.filter((p) => p.controller === seat.seat)"
              :key="permanent.id"
            >
              {{ permanent.name }}
            </li>
          </ul>
        </div>
      </div>
    </section>

    <section class="decks">
      <h3>Decklists</h3>
      <details v-for="deck in results.decks" :key="deck.seat">
        <summary>
          {{ deck.displayName ?? `${deck.seat} (bot)` }} — {{ deck.commanderNames.join(' & ') }}
        </summary>
        <ul>
          <li v-for="card in deck.cards" :key="card.name">{{ card.quantity }} {{ card.name }}</li>
        </ul>
      </details>
    </section>

    <section v-if="results.rngKey" class="key">
      <h3>Random key</h3>
      <p>Every shuffle and random choice in this game came from this key:</p>
      <code data-testid="rng-key">{{ results.rngKey }}</code>
    </section>
  </section>
</template>

<style scoped>
.post-game {
  max-width: 56rem;
  margin: 1.5rem auto;
  display: grid;
  gap: 1rem;
}
.stepper {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.75rem;
}
.board .seat {
  border: 1px solid var(--border, #444);
  border-radius: 6px;
  padding: 0.5rem;
}
.key code {
  word-break: break-all;
}
</style>
