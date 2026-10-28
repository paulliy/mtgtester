<script setup lang="ts">
/**
 * The human seat's side of table diplomacy (ADR 0035 phase 3): answer the offers waiting on you,
 * propose a deal, read the table's deals and records, and the recent talk. The server validates
 * every deal; this panel only builds the terms and shows what came of them.
 */
import { computed, ref, watch } from 'vue';
import { DEAL_DRAFT_MAX_CHARS } from '@mtg/shared';
import type { Deal, DealObligationKind, PlayerId } from '@mtg/shared';
import {
  OBLIGATION_KINDS,
  canAddRow,
  describeOutcome,
  newRow,
  obligationToRow,
  rowToObligation,
  type BuilderRow,
} from '../lib/dealBuilder';
import { describeObligation, describeRounds } from '../lib/tableTalk';
import { useGameStore } from '../stores/game';

const TALK_LINES = 8;

const store = useGameStore();
const me = computed(() => store.humanSeat ?? 'P1');
const seat = computed(() => store.diplomacySeat);

function name(id: PlayerId): string {
  return id === me.value ? 'You' : id;
}

/** Seats still in the game, in table order. */
const livingSeats = computed<PlayerId[]>(() => {
  const eliminated = new Set(store.playerState?.eliminatedPlayers ?? []);
  const all = store.playerState?.seats.map((s) => s.seat) ?? store.seats.map((s) => s.seat);
  return all.filter((id) => !eliminated.has(id));
});

const slotLabel = computed(() =>
  seat.value?.slot === 'afterAttackers' ? 'After attackers' : 'Start of turn',
);

// Builder state. `counterTo` is set while the builder answers an offer instead of proposing.
const partner = ref<PlayerId | ''>('');
const rows = ref<BuilderRow[]>([]);
const rounds = ref(1);
const counterTo = ref<Deal | null>(null);
const draftText = ref('');

const otherParty = computed<PlayerId | ''>(() =>
  counterTo.value !== null ? counterTo.value.proposer : partner.value,
);
const maxRounds = computed(() => seat.value?.maxRounds ?? 1);
const maxPerSide = computed(() => seat.value?.maxObligationsPerSide ?? 1);
const sides = computed<PlayerId[]>(() =>
  otherParty.value === '' ? [me.value] : [me.value, otherParty.value],
);

const canSubmit = computed(() => {
  if (rows.value.length === 0 || otherParty.value === '') return false;
  if (counterTo.value !== null) return true;
  return seat.value?.canPropose === true;
});

function otherChoices(by: PlayerId): PlayerId[] {
  return livingSeats.value.filter((id) => id !== by);
}

function addRow(by: PlayerId): void {
  if (!canAddRow(rows.value, by, maxPerSide.value)) return;
  const row = newRow(by, otherChoices(by));
  if (row !== null) rows.value = [...rows.value, row];
}

function removeRow(index: number): void {
  rows.value = rows.value.filter((_, i) => i !== index);
}

function setKind(row: BuilderRow, kind: string): void {
  row.kind = kind as DealObligationKind;
}

// Changing partner moves the partner's rows over, keeping every row valid.
watch(partner, (next, previous) => {
  if (counterTo.value !== null) return;
  rows.value = rows.value
    .map((row) => {
      const by = row.by === previous && previous !== '' ? next : row.by;
      return { ...row, by };
    })
    .filter((row) => row.by !== '' && row.other !== row.by);
});

// A row whose obligor was switched to the seat it named would name itself: point it elsewhere.
watch(
  rows,
  (list) => {
    for (const row of list) {
      if (row.other === row.by) row.other = otherChoices(row.by)[0] ?? row.other;
    }
  },
  { deep: true },
);

function reset(): void {
  counterTo.value = null;
  rows.value = [];
  rounds.value = 1;
}

function startCounter(deal: Deal): void {
  counterTo.value = deal;
  rows.value = deal.obligations.map(obligationToRow);
  rounds.value = deal.rounds;
}

function submit(): void {
  if (!canSubmit.value || otherParty.value === '') return;
  const obligations = rows.value.map(rowToObligation);
  const length = Math.min(Math.max(1, Math.trunc(rounds.value)), maxRounds.value);
  if (counterTo.value !== null) {
    store.answerDeal(counterTo.value.id, 'decline', { obligations, rounds: length });
  } else {
    store.proposeDeal({ to: otherParty.value, obligations, rounds: length });
  }
  reset();
}

function readAsDeal(): void {
  const text = draftText.value.trim();
  if (text === '' || store.dealDraftPending) return;
  store.requestDealDraft(text);
}

// A reading with terms fills the builder; the player still presses Propose.
watch(
  () => store.dealDraft,
  (draft) => {
    if (draft === null || draft.terms === null) return;
    counterTo.value = null;
    partner.value = draft.terms.to;
    rows.value = draft.terms.obligations.map(obligationToRow);
    rounds.value = draft.terms.rounds;
  },
);

const outcomeText = computed(() =>
  store.lastDealOutcome === null ? null : describeOutcome(store.lastDealOutcome),
);

const recentTalk = computed(() => store.tableTalk.slice(-TALK_LINES));

function dealWords(deal: Deal): string {
  return `${deal.obligations.map((o) => describeObligation(o, name)).join('; ')} ${describeRounds(deal.rounds)}`;
}
</script>

<template>
  <section v-if="seat" class="deals" aria-label="Table talk and deals">
    <h3>Deals</h3>
    <p class="slot">
      {{ slotLabel }} ·
      <span :class="seat.canPropose ? 'yes' : 'no'">{{
        seat.canPropose ? 'you can propose now' : 'you have proposed this slot'
      }}</span>
    </p>

    <p v-if="outcomeText" class="outcome" role="status">{{ outcomeText }}</p>

    <ul v-if="seat.offers.length > 0" class="offers" aria-label="Offers waiting on you">
      <li v-for="deal in seat.offers" :key="deal.id" class="offer">
        <p>
          <strong>{{ deal.proposer }}</strong> offers: {{ dealWords(deal) }}
        </p>
        <div class="buttons">
          <button type="button" @click="store.answerDeal(deal.id, 'accept')">Accept</button>
          <button type="button" @click="store.answerDeal(deal.id, 'decline')">Decline</button>
          <button type="button" @click="startCounter(deal)">Counter</button>
        </div>
      </li>
    </ul>

    <form class="builder" @submit.prevent="submit">
      <h4>{{ counterTo ? `Counter ${counterTo.proposer}'s offer` : 'Propose a deal' }}</h4>
      <label v-if="!counterTo" class="field">
        <span>With</span>
        <select v-model="partner">
          <option value="" disabled>Choose a seat</option>
          <option v-for="id in seat.partners" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>

      <div v-for="(row, index) in rows" :key="index" class="row">
        <label>
          <span class="sr">Owed by</span>
          <select v-model="row.by">
            <option v-for="id in sides" :key="id" :value="id">{{ name(id) }}</option>
          </select>
        </label>
        <label>
          <span class="sr">Promise</span>
          <select
            :value="row.kind"
            @change="setKind(row, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="k in OBLIGATION_KINDS" :key="k.kind" :value="k.kind">
              {{ k.label }}
            </option>
          </select>
        </label>
        <label>
          <span class="sr">{{ row.kind === 'attackPlayer' ? 'Target' : 'Against' }}</span>
          <select v-model="row.other">
            <option v-for="id in otherChoices(row.by)" :key="id" :value="id">
              {{ name(id) }}
            </option>
          </select>
        </label>
        <button type="button" :aria-label="`Remove promise ${index + 1}`" @click="removeRow(index)">
          ×
        </button>
      </div>

      <div class="buttons">
        <button
          v-for="id in sides"
          :key="id"
          type="button"
          :disabled="!canAddRow(rows, id, maxPerSide)"
          @click="addRow(id)"
        >
          + {{ name(id) }}
        </button>
      </div>

      <label class="field">
        <span>Rounds</span>
        <input v-model.number="rounds" type="number" min="1" :max="maxRounds" />
      </label>

      <div class="buttons">
        <button type="submit" :disabled="!canSubmit">
          {{ counterTo ? 'Send counter' : 'Propose' }}
        </button>
        <button v-if="counterTo" type="button" @click="reset">Cancel</button>
      </div>
    </form>

    <div class="draft">
      <label class="field">
        <span>Or say it in words</span>
        <textarea
          v-model="draftText"
          :maxlength="DEAL_DRAFT_MAX_CHARS"
          rows="2"
          placeholder="You leave me alone and I'll hit P3"
        ></textarea>
      </label>
      <button
        type="button"
        :disabled="store.dealDraftPending || draftText.trim() === ''"
        @click="readAsDeal"
      >
        {{ store.dealDraftPending ? 'Reading…' : 'Read as deal' }}
      </button>
      <p v-if="store.dealDraft && store.dealDraft.terms === null" class="outcome" role="status">
        {{ store.dealDraft.message ?? 'That could not be read as a deal.' }}
      </p>
    </div>

    <div v-if="seat.deals.length > 0" class="block">
      <h4>In force</h4>
      <ul>
        <li v-for="deal in seat.deals" :key="deal.id">
          {{ deal.parties.join(' & ') }}: {{ dealWords(deal) }}
        </li>
      </ul>
    </div>

    <div v-if="seat.trust.length > 0" class="block">
      <h4>Records</h4>
      <ul class="trust">
        <li v-for="t in seat.trust" :key="t.seat">
          {{ name(t.seat) }}: {{ t.kept }} kept, {{ t.broken }} broken
        </li>
      </ul>
    </div>

    <div v-if="recentTalk.length > 0" class="block">
      <h4>Table talk</h4>
      <ul class="talk">
        <li v-for="(line, index) in recentTalk" :key="index">{{ line.text }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.deals {
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  padding: 0.4rem 0.5rem;
  font-size: 0.72rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-height: 0;
  overflow: auto;
}
h3,
h4 {
  margin: 0;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
p {
  margin: 0;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.yes {
  color: var(--ok);
}
.no {
  color: var(--muted);
}
.outcome {
  color: var(--accent);
}
.offer {
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 0.3rem 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.builder,
.draft,
.block {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  color: var(--muted);
}
.row {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
  align-items: center;
}
.buttons {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}
.talk li {
  color: var(--muted);
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
