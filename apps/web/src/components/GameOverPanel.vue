<script setup lang="ts">
/**
 * The game-over screen: final standings and stats, plus AI self-review when there is any (ADR
 * 0022 §7, reversing brief §15's cut).
 *
 * This is the one screen every finished game gets, regardless of provider — a random-provider
 * game has no commentary to show, but it still gets a result. It opens itself the moment
 * `gameOver` lands and can be reopened afterwards from the header; closing it just reveals the
 * final board underneath, which by then is the actual final board (see `MatchSession.
 * publishFinalState`), not the board mid-way through the turn that ended the game.
 *
 * Every `keyMistakes` / `keyPlays` turn is a jump link into the timeline. Commentary that names a
 * turn you cannot go and look at is barely commentary at all — the panel closes itself on a jump
 * so the board it sent you to is actually visible.
 */
import { computed } from 'vue';
import type { AiReflection, GameOverPayload, GameResult, PlayerId, SeatSummary } from '@mtg/shared';

const props = defineProps<{
  seats: SeatSummary[];
  result: GameResult;
  /** Reviews that have landed. Fills in seat by seat while the models answer. */
  reflections: AiReflection[];
  /** Seats the server said would review, from `gameOver`. Drives the waiting placeholders. */
  expectedSeats: PlayerId[];
  /** Every seat has answered or failed. A missing review is then final, not pending. */
  complete: boolean;
  standings: GameOverPayload['standings'];
}>();

const emit = defineEmits<{
  (event: 'jump', turn: number): void;
  (event: 'close'): void;
}>();

const bySeat = computed(() => new Map(props.reflections.map((entry) => [entry.seat, entry])));

function seatLabel(seat: PlayerId): string {
  return props.seats.find((candidate) => candidate.seat === seat)?.label ?? seat;
}

function seatArchetype(seat: PlayerId): string {
  return props.seats.find((candidate) => candidate.seat === seat)?.archetypeTag ?? '';
}

const roundCount = computed(() => {
  const numSeats = props.seats.length > 0 ? props.seats.length : 4;
  return Math.ceil(props.result.turnCount / numSeats);
});

function outcomeLabel(row: GameOverPayload['standings'][number]): string {
  if (row.seat === props.result.winnerSeat) return 'Winner';
  if (row.lossReason === null) return props.result.halted ? 'Still standing' : '—';
  // The server writes the reason in player terms; a frame without one shows a plain fact.
  return row.lossLabel ?? 'Eliminated';
}

/** Standings arrive unsorted; 1st belongs at the top of the results table. */
const rankedStandings = computed(() =>
  [...props.standings].sort((a, b) => a.position - b.position),
);

const cards = computed(() =>
  props.expectedSeats.map((seat) => {
    const standing = props.standings.find((candidate) => candidate.seat === seat);
    return {
      seat,
      label: seatLabel(seat),
      archetypeTag: seatArchetype(seat),
      position: standing?.position ?? 0,
      reflection: bySeat.value.get(seat) ?? null,
    };
  }),
);

const pending = computed(() =>
  props.complete ? 0 : cards.value.filter((card) => card.reflection === null).length,
);

const ordinals = ['—', '1st', '2nd', '3rd', '4th'];
function ordinal(position: number): string {
  return ordinals[position] ?? `${position}th`;
}

function jump(turn: number): void {
  emit('jump', turn);
  emit('close');
}
</script>

<template>
  <div class="scrim" @click.self="emit('close')">
    <section class="panel" role="dialog" aria-labelledby="game-over-title">
      <header>
        <h2 id="game-over-title">
          <template v-if="result.halted">⚠️ Game halted</template>
          <template v-else-if="result.winnerSeat"
            >🏆 {{ seatLabel(result.winnerSeat) }} wins</template
          >
          <template v-else>Game drawn</template>
        </h2>
        <span class="meta">Round {{ roundCount }} · {{ result.turnCount }} turns</span>
        <span v-if="pending > 0" class="pending">{{ pending }} still writing…</span>
        <button type="button" class="close" aria-label="Close results" @click="emit('close')">
          ✕
        </button>
      </header>

      <p v-if="result.halted" class="halt-reason">{{ result.haltReason }}</p>

      <table class="standings">
        <thead>
          <tr>
            <th>Place</th>
            <th>Seat</th>
            <th>Deck</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rankedStandings"
            :key="row.seat"
            :class="{ winner: row.seat === result.winnerSeat }"
          >
            <td class="place">{{ ordinal(row.position) }}</td>
            <td class="seat-cell">
              <span class="seat-badge">{{ row.seat }}</span>
              {{ seatLabel(row.seat) }}
            </td>
            <td class="archetype">{{ seatArchetype(row.seat) }}</td>
            <td class="outcome">{{ outcomeLabel(row) }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="cards.length > 0" class="cards">
        <article v-for="card in cards" :key="card.seat" class="seat-card">
          <div class="seat-head">
            <span class="seat-badge">{{ card.seat }}</span>
            <span class="seat-name">{{ card.label }}</span>
            <span v-if="card.archetypeTag" class="seat-archetype">{{ card.archetypeTag }}</span>
            <span class="seat-place">{{ ordinal(card.position) }}</span>
          </div>

          <p v-if="card.reflection === null" class="waiting">
            {{ complete ? 'No review available for this seat.' : 'Writing its review…' }}
          </p>

          <template v-else>
            <p class="summary">{{ card.reflection.summary }}</p>

            <div v-if="card.reflection.threatRead" class="section">
              <h3>Threat read</h3>
              <p class="prose">{{ card.reflection.threatRead }}</p>
            </div>

            <div v-if="card.reflection.keyMistakes.length > 0" class="section">
              <h3>What it got wrong</h3>
              <ul>
                <li v-for="(moment, index) in card.reflection.keyMistakes" :key="`m${index}`">
                  <button type="button" class="turn-link" @click="jump(moment.turn)">
                    T{{ moment.turn }}
                  </button>
                  <span class="what">{{ moment.what }}</span>
                  <span v-if="moment.better" class="better">→ {{ moment.better }}</span>
                </li>
              </ul>
            </div>

            <div v-if="card.reflection.keyPlays.length > 0" class="section">
              <h3>What worked</h3>
              <ul>
                <li v-for="(moment, index) in card.reflection.keyPlays" :key="`p${index}`">
                  <button type="button" class="turn-link" @click="jump(moment.turn)">
                    T{{ moment.turn }}
                  </button>
                  <span class="what">{{ moment.what }}</span>
                </li>
              </ul>
            </div>

            <p class="model">{{ card.reflection.model }}</p>
          </template>
        </article>
      </div>

      <p v-if="cards.length > 0" class="footnote">
        Each bot reviewed its own game from what its seat could see — not from the full board you
        are looking at now.
      </p>
    </section>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: rgb(0 0 0 / 0.6);
}
.panel {
  display: flex;
  flex-direction: column;
  width: min(46rem, 100%);
  max-height: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.45);
}
header {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid var(--line);
}
h2 {
  margin: 0;
  font-size: 0.9rem;
  letter-spacing: -0.01em;
}
.meta {
  color: var(--muted);
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}
.pending {
  color: var(--muted);
  font-size: 0.7rem;
  font-style: italic;
}
.close {
  margin-left: auto;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  color: var(--muted);
  font-size: 0.8rem;
}
.halt-reason {
  margin: 0.6rem 0.9rem 0;
  color: var(--danger);
  font-size: 0.76rem;
}
.standings {
  width: calc(100% - 1.8rem);
  margin: 0.7rem 0.9rem 0;
  border-collapse: collapse;
  font-size: 0.76rem;
}
.standings th {
  text-align: left;
  color: var(--muted);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  padding: 0 0.5rem 0.35rem 0;
}
.standings td {
  padding: 0.3rem 0.5rem 0.3rem 0;
  border-top: 1px solid var(--line);
}
.standings tr.winner .outcome {
  color: var(--ok);
  font-weight: 700;
}
.standings .place {
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.standings .seat-cell {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.standings .archetype {
  color: var(--muted);
  text-transform: capitalize;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.8rem 0.9rem;
  overflow-y: auto;
}
.seat-card {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-2);
  padding: 0.6rem 0.7rem;
}
.seat-head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin-bottom: 0.4rem;
}
.seat-badge {
  border: 1px solid rgb(96 165 250 / 0.35);
  border-radius: 4px;
  background: rgb(96 165 250 / 0.1);
  padding: 0.1rem 0.3rem;
  color: var(--accent);
  font-size: 0.68rem;
  font-weight: 700;
}
.seat-name {
  font-size: 0.78rem;
  font-weight: 600;
}
.seat-archetype {
  color: var(--muted);
  font-size: 0.68rem;
  text-transform: capitalize;
}
.seat-place {
  margin-left: auto;
  color: var(--muted);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
}
.waiting {
  margin: 0;
  color: var(--muted);
  font-size: 0.74rem;
  font-style: italic;
}
.summary {
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.5;
}
.section {
  margin-top: 0.55rem;
}
h3 {
  margin: 0 0 0.2rem;
  color: var(--muted);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.prose {
  margin: 0;
  color: var(--text);
  font-size: 0.74rem;
  line-height: 1.5;
}
ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem;
  font-size: 0.74rem;
  line-height: 1.45;
}
.turn-link {
  flex: none;
  padding: 0 0.28rem;
  border-radius: 3px;
  border-color: rgb(96 165 250 / 0.35);
  color: var(--accent);
  font-size: 0.66rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.turn-link:hover {
  background: rgb(96 165 250 / 0.15);
}
.better {
  color: var(--ok);
}
.model {
  margin: 0.5rem 0 0;
  color: var(--muted);
  font-size: 0.62rem;
  text-align: right;
}
.footnote {
  margin: 0;
  padding: 0.5rem 0.9rem 0.7rem;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.66rem;
  font-style: italic;
  line-height: 1.4;
}

@media (max-width: 620px) {
  .scrim {
    padding: 0.6rem;
  }
}
</style>
