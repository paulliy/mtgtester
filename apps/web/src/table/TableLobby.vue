<script setup lang="ts">
/**
 * The lobby (plan M6 task 4): the seat grid, asking for a seat with a pasted decklist (and its
 * problems, which only you see), and for the host the approval queue, a bot or an open seat per
 * seat, kicking, the invite link, starting and abandoning.
 */
import { computed, ref } from 'vue';
import type { PlayerId } from '@mtg/shared';
import { useTableStore } from '../stores/table';

const table = useTableStore();
const decklist = ref('');
const seat = ref<PlayerId>('P1');
const copied = ref(false);

const state = computed(() => table.state);
const openSeats = computed(() =>
  (state.value?.seats ?? []).filter((entry) => entry.controller === 'open').map((e) => e.seat),
);
const myClaim = computed(() => table.you?.claim ?? null);
const inviteLink = computed(() =>
  state.value?.inviteCode === undefined || table.tableId === null
    ? null
    : `${window.location.origin}/t/${table.tableId}#${state.value.inviteCode}`,
);

function request(): void {
  const target = openSeats.value.includes(seat.value) ? seat.value : openSeats.value[0];
  if (target === undefined) return;
  table.requestSeat(target, decklist.value);
}

/** Choosing a seat by clicking an open one in the grid fills the claim form's seat. */
function choose(target: PlayerId): void {
  if (openSeats.value.includes(target)) seat.value = target;
}
const deckLines = computed(
  () => decklist.value.split('\n').filter((line) => line.trim() !== '').length,
);

async function copyInvite(): Promise<void> {
  if (inviteLink.value === null) return;
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}

const controllerLabel = (controller: string): string =>
  controller === 'human' ? 'Player' : controller === 'bot' ? 'Bot' : 'Open';

/** Seats with someone or something in them, for the plate in the middle of the table. */
const filled = computed(
  () => (state.value?.seats ?? []).filter((entry) => entry.controller !== 'open').length,
);
const PHASE_LABELS: Record<string, string> = {
  open: 'Seating',
  starting: 'Starting',
  playing: 'In play',
  finished: 'Finished',
};
const phaseLabel = computed(() => PHASE_LABELS[state.value?.phase ?? 'open'] ?? '');
</script>

<template>
  <section v-if="state" class="lobby" :class="{ hosting: table.isHost }" data-testid="lobby">
    <div class="main">
      <header class="head dt-rise">
        <p class="dt-kicker">
          {{ phaseLabel }}<template v-if="state.clock"> · {{ state.clock }} clock</template>
        </p>
        <h1 class="dt-title">Table lobby</h1>
        <div class="dt-ornament" aria-hidden="true"><span class="star" /></div>
      </header>

      <div class="table-plan">
        <ul class="seats" data-testid="seat-grid" aria-label="Seats">
          <li
            v-for="(entry, i) in state.seats"
            :key="entry.seat"
            :class="[
              'seat',
              entry.controller,
              {
                you: entry.seat === table.mySeat,
                chosen:
                  !table.mySeat && !myClaim && entry.seat === seat && entry.controller === 'open',
              },
            ]"
            :style="{ animationDelay: `${0.08 + i * 0.07}s` }"
            :data-testid="`seat-${entry.seat}`"
          >
            <div class="seat-top">
              <span class="seat-id">{{ entry.seat }}</span>
              <span class="tag">{{ controllerLabel(entry.controller) }}</span>
            </div>
            <div class="seat-name">
              <span
                v-if="entry.controller === 'human'"
                :class="['dot', { on: entry.connected }]"
                :title="entry.connected ? 'Connected' : 'Away'"
              />
              <strong>{{
                entry.displayName ??
                (entry.controller === 'bot' ? 'Built-in bot' : 'Waiting for a player')
              }}</strong>
              <span v-if="entry.seat === table.mySeat" class="you-mark">You</span>
            </div>
            <div class="seat-actions">
              <button
                v-if="
                  entry.controller === 'open' && !table.mySeat && !myClaim && state.phase === 'open'
                "
                type="button"
                class="dt-btn small"
                :aria-pressed="entry.seat === seat"
                @click="choose(entry.seat)"
              >
                {{ entry.seat === seat ? 'Chosen' : 'Choose' }}
              </button>
              <template v-if="table.isHost && state.phase === 'open'">
                <button
                  v-if="entry.controller === 'open'"
                  type="button"
                  class="dt-btn small"
                  :data-testid="`make-bot-${entry.seat}`"
                  @click="table.setSeat(entry.seat, 'bot')"
                >
                  Bot
                </button>
                <button
                  v-else-if="entry.controller === 'bot'"
                  type="button"
                  class="dt-btn small"
                  @click="table.setSeat(entry.seat, 'open')"
                >
                  Open
                </button>
                <button
                  v-else
                  type="button"
                  class="dt-btn small danger"
                  :data-testid="`kick-${entry.seat}`"
                  @click="table.kick(entry.seat)"
                >
                  Kick
                </button>
              </template>
            </div>
          </li>
        </ul>
        <div class="centre" aria-hidden="true">
          <span class="count"
            >{{ filled }}<span class="of">/{{ state.seats.length }}</span></span
          >
          <span class="dt-kicker">seated</span>
        </div>
      </div>

      <section class="yours" aria-labelledby="yours-title">
        <h2 id="yours-title" class="dt-head"><span class="num">I.</span> Your seat</h2>
        <div v-if="table.mySeat" class="mine dt-plate">
          <span class="big">{{ table.mySeat }}</span>
          <span class="text">You hold {{ table.mySeat }}.</span>
          <button
            v-if="state.phase === 'open'"
            type="button"
            class="dt-btn small"
            @click="table.leaveSeat()"
          >
            Leave seat
          </button>
        </div>
        <div v-else-if="myClaim" class="mine pending dt-plate" data-testid="claim-pending">
          <span class="text">
            Waiting for the host to approve {{ myClaim.seat }}. Your code:
            <strong class="code">{{ myClaim.verificationCode }}</strong>
          </span>
          <button type="button" class="dt-btn small" @click="table.leaveSeat()">Withdraw</button>
        </div>
        <form v-else-if="state.phase === 'open'" class="claim" @submit.prevent="request">
          <label class="dt-field seat-field">
            <span>Seat</span>
            <select v-model="seat" data-testid="claim-seat">
              <option v-for="open in openSeats" :key="open" :value="open">{{ open }}</option>
            </select>
          </label>
          <label class="dt-field deck">
            <span>Decklist</span>
            <textarea
              v-model="decklist"
              rows="10"
              spellcheck="false"
              placeholder="Commander&#10;Atraxa, Praetors' Voice&#10;&#10;Deck&#10;1 Sol Ring&#10;…"
              data-testid="decklist"
            />
          </label>
          <div class="claim-foot">
            <span class="lines">{{ deckLines }} {{ deckLines === 1 ? 'line' : 'lines' }}</span>
            <span v-if="openSeats.length === 0" class="lines">No open seats.</span>
            <button
              type="submit"
              class="dt-btn-primary"
              :disabled="decklist.trim() === '' || openSeats.length === 0"
              data-testid="request-seat"
            >
              Ask for a seat<span class="dt-arr" aria-hidden="true" />
            </button>
          </div>
        </form>
        <ul
          v-if="table.deckProblems.length > 0"
          class="problems dt-note danger"
          role="alert"
          data-testid="problems"
        >
          <li v-for="(problem, index) in table.deckProblems" :key="index">
            {{ problem.message }}
          </li>
        </ul>
      </section>
    </div>

    <aside v-if="table.isHost" class="host" data-testid="host-panel" aria-labelledby="host-title">
      <div class="host-head">
        <p class="dt-kicker">You are the host</p>
        <h2 id="host-title" class="host-title">Host</h2>
      </div>
      <div class="host-body">
        <section v-if="inviteLink" class="block">
          <h3 class="dt-head"><span class="num">I.</span> Invite</h3>
          <input :value="inviteLink" readonly class="invite-link" data-testid="invite-link" />
          <div class="row">
            <button type="button" class="dt-btn small" @click="copyInvite">
              {{ copied ? 'Copied' : 'Copy invite' }}
            </button>
            <button
              v-if="state.phase === 'open'"
              type="button"
              class="dt-btn small"
              @click="table.rotateInvite()"
            >
              New invite
            </button>
          </div>
        </section>

        <section class="block">
          <h3 class="dt-head">
            <span class="num">II.</span> Requests
            <span class="aside">{{ (state.pendingClaims ?? []).length }} waiting</span>
          </h3>
          <ul v-if="(state.pendingClaims ?? []).length > 0" class="claims" data-testid="claims">
            <li v-for="claim in state.pendingClaims" :key="claim.claimId" class="claim-row">
              <span class="who">
                <strong>{{ claim.displayName }}</strong>
                <span class="muted">asks for {{ claim.seat }} · code</span>
                <strong class="code">{{ claim.verificationCode }}</strong>
              </span>
              <span class="row">
                <button
                  type="button"
                  class="dt-btn small approve"
                  :data-testid="`approve-${claim.seat}`"
                  @click="table.approve(claim.claimId)"
                >
                  Approve
                </button>
                <button type="button" class="dt-btn small" @click="table.deny(claim.claimId)">
                  Deny
                </button>
              </span>
            </li>
          </ul>
          <p v-else-if="state.phase === 'open'" class="hint">No seat requests waiting.</p>
        </section>

        <section class="block">
          <h3 class="dt-head"><span class="num">III.</span> Start</h3>
          <p v-if="state.clock" class="hint">Clock: {{ state.clock }}</p>
          <ul
            v-if="!state.canStart && state.startBlockers.length > 0"
            class="blockers dt-note warn"
          >
            <li v-for="blocker in state.startBlockers" :key="blocker">{{ blocker }}</li>
          </ul>
        </section>
      </div>
      <div class="host-foot">
        <button
          v-if="state.phase === 'open'"
          type="button"
          class="dt-btn-primary wide"
          :disabled="!state.canStart"
          data-testid="start"
          @click="table.start()"
        >
          Start<span class="dt-arr" aria-hidden="true" />
        </button>
        <button
          v-if="state.phase === 'starting' || state.phase === 'playing'"
          type="button"
          class="dt-btn danger"
          data-testid="abandon"
          @click="table.abandon()"
        >
          End the game
        </button>
      </div>
    </aside>
  </section>
</template>

<style scoped>
.lobby {
  min-height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.lobby.hosting {
  grid-template-columns: minmax(0, 1fr) minmax(19rem, 26rem);
}
.main {
  width: 100%;
  max-width: 54rem;
  margin: 0 auto;
  padding: 2rem 2rem 3rem;
  display: grid;
  gap: 2rem;
  align-content: start;
}
.head {
  display: grid;
  gap: 0.8rem;
}
.head .dt-kicker {
  margin: 0;
}

/* The four seats around a round table. */
.table-plan {
  position: relative;
}
.seats {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
}
.seat {
  position: relative;
  display: grid;
  gap: 0.7rem;
  min-height: 9rem;
  padding: 0.9rem 1rem 1rem;
  border: 1px solid var(--ink);
  background: var(--paper);
  animation: dtRise 0.55s var(--ease) both;
  transition:
    background-color 0.3s var(--ease),
    box-shadow 0.3s var(--ease);
}
.seat.open {
  border-style: dashed;
}
.seat.chosen {
  background: var(--paper-2);
  box-shadow: inset 0 0 0 1px var(--ink);
}
.seat.you {
  box-shadow:
    inset 0 0 0 2px var(--paper),
    inset 0 0 0 3px var(--ink);
}
/* Odd seats point their content toward the table in the middle. */
.seat:nth-child(odd) {
  padding-right: 4.5rem;
}
.seat:nth-child(even) {
  padding-left: 4.5rem;
}
.seat-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.seat-id {
  font-family: var(--font-display);
  font-size: 2.2rem;
  line-height: 0.9;
  letter-spacing: -0.03em;
}
.tag {
  padding: 0.15rem 0.45rem;
  border: 1px solid var(--ink);
  font-family: var(--font-ui);
  font-size: 0.58rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.seat.human .tag {
  background: var(--ink);
  color: var(--paper);
}
.seat.open .tag {
  border-color: var(--rule);
  color: var(--muted);
}
.seat-name {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}
.seat-name strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-body);
  font-weight: 400;
  font-size: 1rem;
}
.seat.open .seat-name strong {
  color: var(--muted);
}
.you-mark {
  font-family: var(--font-ui);
  font-size: 0.6rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}
.dot {
  flex: 0 0 auto;
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  border: 1px solid var(--ink);
  background: transparent;
}
.dot.on {
  background: var(--ok);
  border-color: var(--ok);
}
.seat-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-self: end;
}
.centre {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 7.5rem;
  height: 7.5rem;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ink);
  border-radius: 50%;
  background: var(--paper-2);
  box-shadow: 0 0 0 0.6rem var(--paper);
  pointer-events: none;
  animation: dtFade 0.8s var(--ease) 0.3s both;
}
.centre::before {
  content: '';
  position: absolute;
  inset: 0.45rem;
  border: 1px solid var(--rule);
  border-radius: 50%;
}
.count {
  font-family: var(--font-display);
  font-size: 2.4rem;
  line-height: 1;
}
.count .of {
  font-size: 1.1rem;
  color: var(--muted);
}

/* Your seat */
.yours {
  display: grid;
  gap: 1rem;
}
.mine {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  padding: 0.9rem 1.1rem;
}
.mine .big {
  font-family: var(--font-display);
  font-size: 2rem;
  line-height: 1;
}
.mine .text {
  flex: 1;
  font-family: var(--font-body);
}
.code {
  display: inline-block;
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--ink);
  font-family: var(--font-body);
  font-weight: 400;
  letter-spacing: 0.12em;
}
.claim {
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr);
  gap: 1rem 1.5rem;
  align-items: start;
}
.claim .deck textarea {
  min-height: 14rem;
}
.claim-foot {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 1rem;
}
.lines {
  margin-right: auto;
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--muted);
}
.problems {
  list-style: none;
}

/* Host panel */
.host {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--ink);
  animation: dtFade 0.6s var(--ease) 0.2s both;
}
.host-head {
  padding: 1.25rem 1.5rem 1rem;
  border-bottom: 1px solid var(--ink);
}
.host-head .dt-kicker {
  margin: 0 0 0.3rem;
}
.host-title {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 2rem;
  line-height: 1;
  letter-spacing: -0.03em;
  text-transform: uppercase;
}
.host-body {
  flex: 1 1 auto;
  padding: 1.25rem 1.5rem;
  display: grid;
  gap: 1.75rem;
  align-content: start;
}
.block {
  display: grid;
  gap: 0.75rem;
}
.invite-link {
  width: 100%;
  min-height: 40px;
  padding: 0.3rem 0.1rem;
  border: 0;
  border-bottom: 1px solid var(--ink);
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.8rem;
  text-overflow: ellipsis;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.claims {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.6rem;
}
.claim-row {
  display: grid;
  gap: 0.55rem;
  padding: 0.75rem;
  border: 1px solid var(--ink);
  background: var(--paper-2);
  animation: dtRise 0.45s var(--ease) both;
}
.who {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.4rem;
  font-family: var(--font-body);
}
.who > strong:first-child {
  font-weight: 400;
  font-size: 1rem;
}
.muted,
.hint {
  color: var(--muted);
}
.hint {
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.85rem;
}
.approve {
  background: var(--ink);
  color: var(--paper);
}
.approve:hover:not(:disabled) {
  background: var(--ink-soft);
}
.blockers {
  list-style: none;
}
.host-foot {
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--ink);
  background: var(--paper-2);
  display: grid;
  gap: 0.6rem;
}

@media (max-width: 980px) {
  .lobby.hosting {
    grid-template-columns: minmax(0, 1fr);
  }
  .host {
    border-left: 0;
    border-top: 1px solid var(--ink);
  }
}
@media (max-width: 640px) {
  .main {
    padding: 1.5rem 1rem 2rem;
  }
  .seats {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.75rem;
  }
  .seat,
  .seat:nth-child(odd),
  .seat:nth-child(even) {
    min-height: 0;
    padding: 0.8rem 0.9rem;
  }
  .centre {
    display: none;
  }
  .claim {
    grid-template-columns: minmax(0, 1fr);
  }
  .host-head,
  .host-body,
  .host-foot {
    padding-left: 1rem;
    padding-right: 1rem;
  }
}
</style>
