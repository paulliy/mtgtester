<script setup lang="ts">
/**
 * The human seat's side of table diplomacy (ADR 0035 phase 3): answer the offers waiting on you,
 * propose a deal, read the table's deals and records, and the recent talk. The server validates
 * every deal; this panel only builds the terms and shows what came of them.
 */
import { computed, ref, watch } from 'vue';
import { DEAL_DRAFT_MAX_CHARS } from '@mtg/shared';
import type { Deal, DealObligationKind, PlayerId, TableTalkLine } from '@mtg/shared';
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
/** Most marks a record bar shows; a longer record is scaled down, keeping any breach visible. */
const MARK_CAP = 8;

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

/** Keep only rows the builder can show: owed by a side of the deal, about another living seat. */
function usableRows(list: BuilderRow[]): BuilderRow[] {
  return list.filter(
    (row) => sides.value.includes(row.by) && otherChoices(row.by).includes(row.other),
  );
}

function startCounter(deal: Deal): void {
  counterTo.value = deal;
  rows.value = usableRows(deal.obligations.map(obligationToRow));
  rounds.value = deal.rounds;
}

// A counter whose offer has lapsed or been withdrawn has nothing left to answer.
watch(
  () => seat.value?.offers.map((d) => d.id) ?? [],
  (ids) => {
    if (counterTo.value !== null && !ids.includes(counterTo.value.id)) {
      reset();
      store.lastDealOutcome = { kind: 'refused', reason: 'noSuchOffer' };
    }
  },
);

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
    rows.value = usableRows(draft.terms.obligations.map(obligationToRow));
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

/** The commander a seat plays, for the offer's header. */
function commanderOf(id: PlayerId): string | null {
  const seatState = store.playerState?.seats.find((s) => s.seat === id);
  const names = (seatState?.commanders ?? []).map((c) => c.name);
  return names.length > 0 ? names.join(' & ') : null;
}

/** A record as a row of marks: kept first, then broken, scaled to at most `MARK_CAP`. */
function marks(kept: number, broken: number): ('kept' | 'broken')[] {
  const total = kept + broken;
  let k = kept;
  let b = broken;
  if (total > MARK_CAP) {
    b = broken === 0 ? 0 : Math.max(1, Math.round((broken * MARK_CAP) / total));
    k = MARK_CAP - b;
  }
  return [...Array<'kept'>(k).fill('kept'), ...Array<'broken'>(b).fill('broken')];
}

function trustOf(id: PlayerId): { kept: number; broken: number } {
  return seat.value?.trust.find((t) => t.seat === id) ?? { kept: 0, broken: 0 };
}

function recordWords(kept: number, broken: number): string {
  if (kept + broken === 0) return 'no deals yet';
  const parts: string[] = [];
  if (kept > 0) parts.push(`${kept} kept`);
  if (broken > 0) parts.push(`${broken} broken`);
  return parts.join(' · ');
}

function recordTip(id: PlayerId): string {
  const { kept, broken } = trustOf(id);
  const who = id === me.value ? 'You' : id;
  if (kept + broken === 0) return `${who} ${id === me.value ? 'have' : 'has'} made no deals yet`;
  return `${who} broke ${broken} of ${kept + broken} deals`;
}

// Offers on the table: the ones waiting, plus any decided this slot, which keep their place.
type Verdict = 'accepted' | 'declined';
const decided = ref<{ deal: Deal; verdict: Verdict }[]>([]);

const shownOffers = computed(() => {
  const open = (seat.value?.offers ?? []).map((deal) => ({
    deal,
    verdict: decided.value.find((d) => d.deal.id === deal.id)?.verdict ?? null,
  }));
  const gone = decided.value
    .filter((d) => !open.some((o) => o.deal.id === d.deal.id))
    .map((d) => ({ deal: d.deal, verdict: d.verdict as Verdict | null }));
  return [...open, ...gone];
});

function decide(deal: Deal, verdict: Verdict): void {
  if (decided.value.some((d) => d.deal.id === deal.id)) return;
  decided.value = [...decided.value, { deal, verdict }];
  store.answerDeal(deal.id, verdict === 'accepted' ? 'accept' : 'decline');
}

// An offer that comes back (the preview's reset) is open again, not decided.
watch(
  () => seat.value?.offers.map((d) => d.id) ?? [],
  (ids, before) => {
    decided.value = decided.value.filter(
      (d) => !(ids.includes(d.deal.id) && !before.includes(d.deal.id)),
    );
  },
);

// A decided offer keeps its place, stamp and faded buttons until the next negotiation slot, so
// nothing around it moves when the answer lands.
watch(
  () => `${seat.value?.turn}:${seat.value?.slot}`,
  () => {
    decided.value = [];
  },
);

// A refused answer did not decide anything: take the stamp back.
watch(
  () => store.lastDealOutcome,
  (outcome) => {
    if (outcome?.kind === 'refused') decided.value = [];
  },
);

function promiseWords(deal: Deal): string {
  return deal.obligations.map((o) => describeObligation(o, name)).join(' · ');
}

function owedBy(deal: Deal): string {
  const sides = [...new Set(deal.obligations.map((o) => o.by))];
  if (sides.length > 1) return deal.parties.includes(me.value) ? 'Both of you' : 'Both sides';
  return sides[0] === undefined ? '' : name(sides[0]);
}

function partiesWords(deal: Deal): string {
  return deal.parties.map((p) => name(p)).join(' & ');
}

/** A talk line without its leading "P2: ", which the seat column already shows. */
function talkSeat(line: TableTalkLine): string | null {
  const message = line.message as { from?: PlayerId };
  return message.from ?? null;
}

function talkText(line: TableTalkLine): string {
  const from = talkSeat(line);
  return from !== null && line.text.startsWith(`${from}: `)
    ? line.text.slice(from.length + 2)
    : line.text;
}
</script>

<template>
  <section v-if="seat" class="deals" aria-label="Table talk and deals">
    <header class="deals-head">
      <h3>Deals</h3>
      <p class="slot">
        Round {{ seat.turn }} · {{ slotLabel }} ·
        <span :class="seat.canPropose ? 'yes' : 'no'">{{
          seat.canPropose ? 'you can propose now' : 'you have proposed this slot'
        }}</span>
      </p>
      <p class="outcome" role="status">{{ outcomeText ?? '' }}</p>
    </header>

    <div class="cols">
      <div class="col col-offer">
        <ul v-if="shownOffers.length > 0" class="offers" aria-label="Offers waiting on you">
          <li
            v-for="{ deal, verdict } in shownOffers"
            :key="deal.id"
            class="offer"
            :class="{ decided: verdict !== null }"
          >
            <div class="offer-head">
              <h4>
                Offer from seat {{ deal.proposer }}
                <template v-if="commanderOf(deal.proposer)">
                  · {{ commanderOf(deal.proposer) }}</template
                >
              </h4>
              <span class="offer-when">
                <span
                  v-if="trustOf(deal.proposer).broken > 0"
                  class="marks"
                  role="img"
                  :aria-label="recordTip(deal.proposer)"
                  :title="recordTip(deal.proposer)"
                >
                  <i
                    v-for="(m, i) in marks(
                      trustOf(deal.proposer).kept,
                      trustOf(deal.proposer).broken,
                    )"
                    :key="i"
                    class="mark"
                    :class="m"
                  ></i>
                </span>
                Round {{ deal.proposedTurn }}
              </span>
            </div>
            <div class="offer-body">
              <p class="quote">{{ dealWords(deal) }}</p>
              <div class="divider">
                <span v-if="verdict" class="stamp" :class="verdict" role="status">{{
                  verdict === 'accepted' ? 'Deal struck' : 'Declined'
                }}</span>
              </div>
              <dl class="terms">
                <dt>Promise</dt>
                <dd>{{ promiseWords(deal) }}</dd>
                <dt>Rounds</dt>
                <dd>{{ deal.rounds }}</dd>
                <dt>Owed by</dt>
                <dd>{{ owedBy(deal) }}</dd>
              </dl>
              <div class="actions">
                <button
                  type="button"
                  class="accept"
                  :disabled="verdict !== null"
                  :aria-label="`Accept ${deal.proposer}'s offer`"
                  @click="decide(deal, 'accepted')"
                >
                  Accept
                </button>
                <button
                  type="button"
                  class="counter"
                  :disabled="verdict !== null"
                  :aria-label="`Counter ${deal.proposer}'s offer`"
                  @click="startCounter(deal)"
                >
                  Counter
                </button>
                <button
                  type="button"
                  class="decline"
                  :disabled="verdict !== null"
                  :aria-label="`Decline ${deal.proposer}'s offer`"
                  @click="decide(deal, 'declined')"
                >
                  [ Decline ]
                </button>
              </div>
            </div>
          </li>
        </ul>

        <form class="builder" @submit.prevent="submit">
          <h4 class="section">
            {{ counterTo ? `Counter ${counterTo.proposer}'s offer` : 'Propose a deal' }}
          </h4>
          <div v-if="!counterTo" class="field" role="group" aria-label="With">
            <span class="label">With</span>
            <div class="seg">
              <button
                v-for="id in seat.partners"
                :key="id"
                type="button"
                :aria-pressed="partner === id"
                @click="partner = id"
              >
                {{ id }}
              </button>
              <span v-if="seat.partners.length === 0" class="none">Nobody is negotiating now</span>
            </div>
          </div>

          <div v-for="(row, index) in rows" :key="index" class="row">
            <label class="sel">
              <span class="sr">Owed by</span>
              <select v-model="row.by">
                <option v-for="id in sides" :key="id" :value="id">{{ name(id) }}</option>
              </select>
            </label>
            <label class="sel">
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
            <label class="sel">
              <span class="sr">{{ row.kind === 'attackPlayer' ? 'Target' : 'Against' }}</span>
              <select v-model="row.other">
                <option v-for="id in otherChoices(row.by)" :key="id" :value="id">
                  {{ name(id) }}
                </option>
              </select>
            </label>
            <button
              type="button"
              class="remove"
              :aria-label="`Remove promise ${index + 1}`"
              @click="removeRow(index)"
            >
              ×
            </button>
          </div>

          <div class="adds">
            <button
              v-for="id in sides"
              :key="id"
              type="button"
              class="outline"
              :disabled="!canAddRow(rows, id, maxPerSide)"
              @click="addRow(id)"
            >
              + {{ name(id) }}
            </button>
          </div>

          <div class="field" role="group" aria-label="Rounds">
            <span class="label">Rounds</span>
            <div v-if="maxRounds <= 6" class="seg">
              <button
                v-for="n in maxRounds"
                :key="n"
                type="button"
                :aria-pressed="Math.trunc(rounds) === n"
                :aria-label="`${n} ${n === 1 ? 'round' : 'rounds'}`"
                @click="rounds = n"
              >
                {{ n }}
              </button>
            </div>
            <input v-else v-model.number="rounds" type="number" min="1" :max="maxRounds" />
          </div>

          <div class="actions">
            <button type="submit" class="accept" :disabled="!canSubmit">
              {{ counterTo ? 'Send counter' : 'Propose' }}
            </button>
            <button v-if="counterTo" type="button" class="counter" @click="reset">Cancel</button>
          </div>
        </form>

        <div class="draft">
          <label class="field">
            <span class="label">Or say it in words</span>
            <textarea
              v-model="draftText"
              :maxlength="DEAL_DRAFT_MAX_CHARS"
              rows="2"
              placeholder="You leave me alone and I'll hit P3"
            ></textarea>
          </label>
          <div class="actions">
            <button
              type="button"
              class="counter"
              :disabled="store.dealDraftPending || draftText.trim() === ''"
              @click="readAsDeal"
            >
              {{ store.dealDraftPending ? 'Reading…' : 'Read as deal' }}
            </button>
          </div>
          <p v-if="store.dealDraft && store.dealDraft.terms === null" class="outcome" role="status">
            {{ store.dealDraft.message ?? 'That could not be read as a deal.' }}
          </p>
        </div>
      </div>

      <div v-if="seat.deals.length > 0 || seat.trust.length > 0" class="col col-state">
        <section v-if="seat.deals.length > 0" class="block" aria-label="In force">
          <h4 class="section">In force</h4>
          <ul class="force">
            <li v-for="deal in seat.deals" :key="deal.id">
              <span class="force-words">{{ promiseWords(deal) }}</span>
              <span
                class="rounds"
                role="img"
                :aria-label="`${deal.rounds} ${deal.rounds === 1 ? 'round' : 'rounds'}`"
              >
                <i v-for="n in deal.rounds" :key="n" class="box"></i>
              </span>
              <span class="force-meta"
                >{{ partiesWords(deal) }} · {{ describeRounds(deal.rounds) }}</span
              >
            </li>
          </ul>
        </section>

        <section v-if="seat.trust.length > 0" class="block" aria-label="Records">
          <h4 class="section">Records</h4>
          <ul class="trust">
            <li v-for="t in seat.trust" :key="t.seat" :title="recordTip(t.seat)">
              <span class="seatname">{{ name(t.seat) }}</span>
              <span class="bar" aria-hidden="true">
                <i v-for="(m, i) in marks(t.kept, t.broken)" :key="i" class="mark" :class="m"></i>
              </span>
              <span class="rec-text">{{ recordWords(t.kept, t.broken) }}</span>
            </li>
          </ul>
          <p class="legend" aria-hidden="true">
            <i class="mark kept"></i>Kept<i class="mark broken"></i>Broken
          </p>
        </section>
      </div>

      <div v-if="recentTalk.length > 0" class="col col-talk">
        <section class="block" aria-label="Table talk lines">
          <h4 class="section">Table talk</h4>
          <ul class="talk">
            <li v-for="line in recentTalk" :key="line.sequence">
              <span class="talk-round">R{{ line.turn }}</span>
              <span class="talk-text">
                <span v-if="talkSeat(line)" class="talk-seat">{{ talkSeat(line) }}</span>
                {{ talkText(line) }}
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * The deal panel in Decktank's language (redesign plan phase 7): an offer card with its quote in
 * Bodoni, ink rules, outlined and solid buttons, round boxes and kept/broken marks. It sits in the
 * game log drawer (about 20rem wide) and on the preview page (wide), so it is one column and
 * becomes three when its own container is wide.
 */
.deals {
  container-type: inline-size;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.8rem;
  line-height: 1.5;
}
.deals-head {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
h3,
h4 {
  margin: 0;
  font-weight: 400;
}
h3 {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
p {
  margin: 0;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.slot {
  font-size: 0.75rem;
  color: var(--muted);
}
.yes {
  color: var(--ok);
}
.no {
  color: var(--muted);
}
/* One line is always reserved, so an answer's outcome never pushes the offer down. */
.outcome {
  min-height: 1.5em;
  color: var(--ink);
}
.draft .outcome {
  min-height: 0;
  padding: 0.5rem 0.7rem;
  border-left: 3px solid var(--ink);
  background: var(--paper);
}
.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1.5rem;
}
.col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
@container (min-width: 60rem) {
  .cols {
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 0.9fr);
    gap: 2rem;
    align-items: start;
  }
}

/* Section heads: small capitals over an ink rule. */
.section {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid var(--ink);
}
.block {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* Buttons: solid primary, outlined, and the bracketed text button. */
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
}
button:disabled {
  cursor: default;
}
button:focus-visible,
select:focus-visible,
textarea:focus-visible,
input:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.75rem;
}
.accept,
.counter,
.outline {
  min-height: 44px;
  padding: 0 1.05rem;
  font-family: var(--font-ui);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  transition:
    background-color 0.35s var(--ease),
    color 0.35s var(--ease),
    opacity 0.45s var(--ease);
}
.accept {
  border: 1px solid var(--ink);
  background: var(--ink);
  color: var(--paper);
}
.accept:hover:not(:disabled) {
  background: var(--ink-soft);
}
.counter,
.outline {
  border: 1px solid var(--ink);
  background: transparent;
}
.counter:hover:not(:disabled),
.outline:hover:not(:disabled) {
  background: var(--ink);
  color: var(--paper);
}
.decline,
.remove {
  min-height: 44px;
  border: 0;
  background: none;
  padding: 0 0.25rem;
  font-size: 0.8rem;
  white-space: nowrap;
  transition: opacity 0.45s var(--ease);
}
.decline:hover:not(:disabled),
.remove:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 0.35em;
}
.remove {
  min-width: 44px;
  font-size: 1.1rem;
}
.deals button:disabled {
  opacity: 0.35;
}

/* An offer: a plate with its header band, the quote, the terms, then the actions. */
.offers {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.offer {
  border: 1px solid var(--ink);
  background: var(--paper);
  animation: dealRise 0.5s var(--ease) both;
}
.offer-head {
  padding: 0.75rem 1rem;
  background: var(--paper-2);
  border-bottom: 1px solid var(--ink);
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 0.35rem 1rem;
}
.offer-head h4 {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.offer-when {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.72rem;
  color: var(--muted);
}
.offer-body {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}
.quote {
  font-family: var(--font-display);
  font-size: 1.35rem;
  line-height: 1.2;
}
/* The stamp sits on the divider, so it never covers the terms or the buttons. */
.divider {
  position: relative;
  height: 0;
  border-top: 1px solid var(--ink);
  margin-top: -0.1rem;
}
.stamp {
  position: absolute;
  right: 0;
  top: 0;
  transform: translateY(-50%) rotate(-4deg);
  z-index: 1;
  padding: 0.25rem 0.7rem;
  border: 3px double var(--ink);
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 0.8rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  animation: dealStamp 0.6s var(--ease) both;
}
.stamp.accepted {
  color: var(--warm);
  border-color: var(--warm);
}
.terms {
  margin: 0;
  padding-top: 0.2rem;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.4rem 1.1rem;
  font-size: 0.8rem;
}
.terms dt {
  font-family: var(--font-ui);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.terms dd {
  margin: 0;
  overflow-wrap: anywhere;
}

/* Kept and broken marks: solid bar, warm hatched bar. */
.marks,
.bar {
  display: inline-flex;
  gap: 3px;
}
.mark {
  display: inline-block;
  width: 1.1rem;
  height: 0.55rem;
  border: 1px solid var(--ink);
  background: var(--ink);
}
.mark.broken {
  border-color: var(--warm);
  background: repeating-linear-gradient(45deg, var(--warm) 0 1px, transparent 1px 3px);
}
.legend {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.7rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--muted);
}
.legend .mark.broken {
  margin-left: 0.6rem;
}

/* The builder. */
.builder,
.draft {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}
.label {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.seg {
  display: flex;
  flex-wrap: wrap;
}
.seg button {
  flex: 1 1 0;
  min-height: 44px;
  margin: 0 0 0 -1px;
  padding: 0 0.8rem;
  border: 1px solid var(--ink);
  background: transparent;
  font-family: var(--font-ui);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  transition:
    background-color 0.3s var(--ease),
    color 0.3s var(--ease);
}
.seg button:first-child {
  margin-left: 0;
}
.seg button[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
.none {
  color: var(--muted);
}
.row {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr) minmax(0, 0.8fr) auto;
  gap: 0.5rem;
  align-items: end;
}
@container (max-width: 26rem) {
  .accept,
  .counter {
    padding: 0 0.8rem;
  }
  .row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .row .sel:nth-child(2) {
    grid-column: 1 / 3;
    grid-row: 2;
  }
  .row .remove {
    grid-row: 1;
    grid-column: 3;
  }
}
.adds {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
/* A styled select: an underline and an ink caret instead of the browser's own control. */
.sel {
  position: relative;
  display: block;
  min-width: 0;
}
.sel select {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  min-height: 44px;
  padding: 0.3rem 1.4rem 0.3rem 0.1rem;
  border: 0;
  border-bottom: 1px solid var(--ink);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.85rem;
  cursor: pointer;
  text-overflow: ellipsis;
}
.sel::after {
  content: '';
  position: absolute;
  right: 0.2rem;
  top: 50%;
  width: 0.45rem;
  height: 0.45rem;
  border-right: 1px solid var(--ink);
  border-bottom: 1px solid var(--ink);
  transform: translateY(-70%) rotate(45deg);
  pointer-events: none;
}
.sel select option {
  background: var(--paper);
  color: var(--ink);
}
input[type='number'],
textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.85rem;
}
input[type='number'] {
  min-height: 44px;
  padding: 0 0.6rem;
}
textarea {
  padding: 0.55rem 0.65rem;
  line-height: 1.45;
  resize: vertical;
}
textarea::placeholder {
  color: var(--muted);
}

/* In force: a row of words, its round boxes and who it binds. */
.force li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.2rem 1rem;
  align-content: center;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--rule);
  animation: dealSlide 0.5s var(--ease) both;
}
.force-words {
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.rounds {
  display: flex;
  gap: 3px;
  align-items: center;
}
.box {
  display: inline-block;
  width: 0.9rem;
  height: 0.9rem;
  border: 1px solid var(--ink);
  background: transparent;
}
.force-meta {
  grid-column: 1 / -1;
  font-size: 0.72rem;
  color: var(--muted);
}

/* Records. */
.trust {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.trust li {
  display: grid;
  grid-template-columns: 2.4rem minmax(0, 1fr);
  gap: 0.1rem 0.6rem;
  align-items: center;
}
.seatname {
  font-family: var(--font-display);
  font-size: 1.3rem;
  line-height: 1;
}
.rec-text {
  grid-column: 2;
  font-size: 0.75rem;
  color: var(--muted);
}
.bar {
  flex-wrap: wrap;
  min-height: 0.6rem;
}

/* Table talk. */
.talk li {
  display: grid;
  grid-template-columns: 2.2rem minmax(0, 1fr);
  gap: 0.6rem;
  padding: 0.45rem 0;
  border-bottom: 1px solid var(--rule);
  font-size: 0.8rem;
  line-height: 1.5;
  animation: dealSlide 0.5s var(--ease) both;
}
.talk-round {
  color: var(--muted);
}
.talk-text {
  overflow-wrap: anywhere;
}
.talk-seat {
  font-family: var(--font-ui);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@keyframes dealRise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes dealSlide {
  from {
    opacity: 0;
    transform: translateX(-10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes dealStamp {
  0% {
    opacity: 0;
    transform: translateY(-50%) scale(1.35) rotate(-8deg);
  }
  60% {
    opacity: 1;
  }
  100% {
    opacity: 1;
    transform: translateY(-50%) rotate(-4deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .offer,
  .stamp,
  .force li,
  .talk li {
    animation: none;
  }
  .accept,
  .counter,
  .outline,
  .decline,
  .seg button {
    transition: none;
  }
}
</style>
