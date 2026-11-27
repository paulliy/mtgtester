<script setup lang="ts">
/**
 * The opening hand, Arena-style: the whole hand fanned large across a darkened board, with
 * Mulligan and Keep as the only two choices and a line saying what the mulligan will cost.
 * Covers both decisions of the London mulligan — keep or mulligan, then (after a second
 * mulligan or later) which cards to put on the bottom, one click per card. The engine decides
 * every count; this only reads them from the request and the seat.
 *
 * With no request (`request` null) it is the wait after you chose Mulligan: in multiplayer each
 * player answers keep-or-mulligan in turn order and the new hands are dealt only once everyone
 * has (CR 103.5), so the screen stays up, buttonless, saying so, instead of dropping you on the
 * board with your old hand until the next question.
 */
import { computed } from 'vue';
import type { SpectatorCard } from '@mtg/shared';
import type { DecisionRequest } from '../lib/protocol';
import CardImage from './CardImage.vue';

const props = defineProps<{
  request: DecisionRequest | null;
  cards: SpectatorCard[];
  mulligansTaken: number;
}>();
const emit = defineEmits<{ choose: [actionId: number] }>();

const waiting = computed(() => props.request === null);
const bottoming = computed(() => props.request?.decisionType === 'bottomCards');
const keepAction = computed(() => props.request?.legalActions.find((a) => a.type === 'keep'));
const mulliganAction = computed(() =>
  props.request?.legalActions.find((a) => a.type === 'mulligan'),
);

/** Keeping now puts this many on the bottom: every mulligan after the free first one (103.4c). */
const bottomIfKept = computed(() => Math.max(0, props.mulligansTaken - 1));
/** And keeping the next hand, after one more mulligan, puts this many. */
const bottomAfterMulligan = computed(() => props.mulligansTaken);
const keepCount = computed(() => props.cards.length - bottomIfKept.value);

/**
 * "put 2 more card(s) on the bottom" → 2; the engine asks for one card at a time.
 *
 * The only engine-prompt read left in the browser. No presentation field carries the count (ADR
 * 0032 decision 3 lists none), and it cannot be derived from the hand: the engine bottoms
 * `min(mulligans - 1, hand size)` cards, so a rules constant here would drift. The proper fix is
 * the engine saying the count (`turn/mulligan.ts` knows it) in a `DecisionPresentation` field.
 */
const bottomRemaining = computed(() => {
  const request = props.request;
  if (request === null) return null;
  // eslint-disable-next-line no-restricted-syntax -- no typed field carries the remaining count; see above
  const match = /put (\d+) more/.exec(request.prompt);
  return match === null ? null : Number(match[1]);
});

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const heading = computed(() => {
  if (waiting.value) return 'Mulligan chosen';
  if (bottoming.value) {
    return bottomRemaining.value === null
      ? 'Choose a card to put on the bottom'
      : `Choose ${plural(bottomRemaining.value, 'card')} to put on the bottom`;
  }
  return props.mulligansTaken === 0
    ? 'Opening hand'
    : `Opening hand · after ${plural(props.mulligansTaken, 'mulligan')}`;
});

const mulliganNote = computed(() =>
  bottomAfterMulligan.value === 0
    ? 'Your first mulligan is free: you draw a fresh 7.'
    : `You will return ${plural(bottomAfterMulligan.value, 'card')} to the bottom of your library.`,
);

function bottomActionFor(card: SpectatorCard): number | null {
  const action = props.request?.legalActions.find(
    (a) =>
      a.type === 'bottomCard' &&
      a.interaction?.kind === 'choice' &&
      a.interaction.subjectId === card.id,
  );
  return action?.id ?? null;
}

/** Each card's place in the fan: -1 at the left edge, 0 in the middle, 1 at the right edge. */
function fanStyle(index: number): Record<string, string> {
  const n = props.cards.length;
  const offset = n <= 1 ? 0 : (index - (n - 1) / 2) / ((n - 1) / 2);
  return {
    '--d': String(offset),
    '--d2': String(offset * offset),
    '--i': String(index),
  };
}
</script>

<template>
  <Teleport to="body">
    <div class="opening-hand" role="dialog" aria-modal="true" aria-labelledby="opening-hand-title">
      <h2 id="opening-hand-title" class="title">{{ heading }}</h2>
      <!-- Keyed on the cards, so a fresh hand after a mulligan deals in again. -->
      <div
        :key="cards.map((c) => c.id).join()"
        class="fan"
        :class="{ choosing: bottoming }"
        :style="{ '--n': String(cards.length) }"
      >
        <template v-for="(card, index) in cards" :key="card.id">
          <button
            v-if="bottoming"
            type="button"
            class="fan-card pick"
            :style="fanStyle(index)"
            :disabled="bottomActionFor(card) === null"
            :aria-label="`Put ${card.name} on the bottom`"
            @click="bottomActionFor(card) !== null && emit('choose', bottomActionFor(card)!)"
          >
            <CardImage
              :scryfall-id="card.scryfallId"
              :name="card.name"
              size="normal"
              :provisional="card.provisional === true"
            />
            <span class="pick-label" aria-hidden="true">To bottom</span>
          </button>
          <div v-else class="fan-card" :style="fanStyle(index)">
            <CardImage
              :scryfall-id="card.scryfallId"
              :name="card.name"
              size="normal"
              :provisional="card.provisional === true"
            />
          </div>
        </template>
      </div>
      <p v-if="waiting" class="note waiting-note" role="status" data-testid="mulligan-waiting">
        Waiting for the other players to keep or mulligan. Your new hand is dealt once everyone has
        decided.
      </p>
      <div v-else-if="!bottoming" class="choices">
        <div class="choice">
          <button
            v-if="mulliganAction"
            type="button"
            class="big mulligan"
            @click="emit('choose', mulliganAction.id)"
          >
            Mulligan
          </button>
          <p class="note">{{ mulliganNote }}</p>
        </div>
        <div class="choice">
          <button
            v-if="keepAction"
            type="button"
            class="big keep"
            @click="emit('choose', keepAction.id)"
          >
            Keep {{ keepCount }}
          </button>
          <p v-if="bottomIfKept > 0" class="note">
            Then choose {{ plural(bottomIfKept, 'card') }} to put on the bottom.
          </p>
        </div>
      </div>
      <p v-else class="note">Click a card to put it on the bottom of your library.</p>
    </div>
  </Teleport>
</template>

<style scoped>
.opening-hand {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2.2rem;
  padding: 1.5rem 1rem 2rem;
  box-sizing: border-box;
  overflow: hidden;
  /* Decktank (ADR 0052): the page dimmed under a paper wash, not a dark stage. */
  background: color-mix(in srgb, var(--paper) 92%, transparent);
  backdrop-filter: blur(4px);
  color: var(--ink);
}
.title {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(2rem, 4vw, 3.2rem);
  font-weight: 400;
  line-height: 1;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  color: var(--ink);
}
/*
 * The fan: cards overlap by a quarter of their width and turn about a point below the row, so the
 * hand arcs like one held in the hand. Width shrinks with hand size and the viewport.
 */
.fan {
  /* n cards overlapping by a quarter span 0.75n + 0.25 widths; the margin leaves room for the
     outer cards' tilt. */
  --w: min(14rem, calc((100vw - 9rem) / (var(--n) * 0.75 + 0.25)), 30vh);
  display: flex;
  justify-content: center;
  padding-top: 2rem;
}
.fan-card {
  position: relative;
  width: var(--w);
  flex-shrink: 0;
  margin-left: calc(var(--w) * -0.25);
  padding: 0;
  border: none;
  background: none;
  border-radius: 5%;
  box-shadow: 0 10px 24px var(--lift-shadow);
  transform-origin: 50% 140%;
  transform: translateY(calc(var(--d2) * 1.4rem)) rotate(calc(var(--d) * 9deg));
  transition:
    translate 160ms ease,
    scale 160ms ease,
    box-shadow 160ms ease;
  animation: deal 420ms cubic-bezier(0.2, 0.8, 0.3, 1) backwards;
  animation-delay: calc(var(--i) * 70ms);
}
.fan-card:first-child {
  margin-left: 0;
}
.fan-card:hover,
.fan-card:focus-visible {
  z-index: 10;
  translate: 0 -1.6rem;
  scale: 1.08;
  box-shadow: 0 16px 34px var(--lift-shadow);
}
@keyframes deal {
  from {
    opacity: 0;
    translate: 0 50vh;
  }
}
.fan-card.pick {
  cursor: pointer;
}
.fan-card.pick:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
.pick-label {
  position: absolute;
  left: 50%;
  bottom: 8%;
  translate: -50% 0;
  padding: 0.3rem 0.8rem;
  background: var(--ink);
  color: var(--paper);
  font-family: var(--font-ui);
  font-size: 0.68rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 120ms ease;
}
.fan-card.pick:hover .pick-label,
.fan-card.pick:focus-visible .pick-label {
  opacity: 1;
}
.choices {
  display: flex;
  gap: 3rem;
  align-items: flex-start;
}
.choice {
  width: 15rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.7rem;
}
.big {
  width: 100%;
  min-height: 52px;
  padding: 0 1rem;
  border: 1px solid var(--ink);
  border-radius: 0;
  font-family: var(--font-ui);
  font-size: 0.9rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    background-color 0.35s var(--ease),
    color 0.35s var(--ease);
}
.big.mulligan {
  background: var(--paper);
  color: var(--ink);
}
.big.mulligan:hover:not(:disabled) {
  background: var(--ink);
  color: var(--paper);
}
.big.keep {
  background: var(--ink);
  color: var(--paper);
}
.big.keep:hover:not(:disabled) {
  background: var(--ink-soft);
}
.note {
  margin: 0;
  max-width: 17rem;
  text-align: center;
  font-family: var(--font-body);
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--muted);
}
.waiting-note {
  max-width: 24rem;
}
</style>
