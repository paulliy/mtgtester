<script setup lang="ts">
/**
 * Post-game AI commentary (ADR 0022 §7, reversing brief §15's cut).
 *
 * One card per AI seat, each written by that seat about its own game. Shown over the final board
 * rather than tucked into the log column: this is prose, it is the last thing the user reads, and
 * it is the only screen in the app where the bots explain themselves.
 *
 * Every `keyMistakes` / `keyPlays` turn is a jump link into the timeline. Commentary that names a
 * turn you cannot go and look at is barely commentary at all — the panel closes itself on a jump
 * so the board it sent you to is actually visible.
 */
import { computed } from 'vue';
import type { AiReflection, PlayerId, SeatSummary } from '@mtg/shared';

const props = defineProps<{
  seats: SeatSummary[];
  /** Reviews that have landed. Fills in seat by seat while the models answer. */
  reflections: AiReflection[];
  /** Seats the server said would review, from `gameOver`. Drives the waiting placeholders. */
  expectedSeats: PlayerId[];
  /** Every seat has answered or failed. A missing review is then final, not pending. */
  complete: boolean;
  standings: Array<{ seat: PlayerId; position: number; lossReason: string | null }>;
}>();

const emit = defineEmits<{
  (event: 'jump', turn: number): void;
  (event: 'close'): void;
}>();

const bySeat = computed(() => new Map(props.reflections.map((entry) => [entry.seat, entry])));

const cards = computed(() =>
  props.expectedSeats.map((seat) => {
    const summary = props.seats.find((candidate) => candidate.seat === seat);
    const standing = props.standings.find((candidate) => candidate.seat === seat);
    return {
      seat,
      label: summary?.label ?? seat,
      archetypeTag: summary?.archetypeTag ?? '',
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
    <section class="commentary" role="dialog" aria-labelledby="commentary-title">
      <header>
        <h2 id="commentary-title">Post-game commentary</h2>
        <span v-if="pending > 0" class="pending">{{ pending }} still writing…</span>
        <button type="button" class="close" aria-label="Close commentary" @click="emit('close')">
          ✕
        </button>
      </header>

      <div class="cards">
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

      <p class="footnote">
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
.commentary {
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
  font-size: 0.85rem;
  letter-spacing: -0.01em;
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
